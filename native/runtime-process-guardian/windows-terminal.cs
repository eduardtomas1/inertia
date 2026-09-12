using System;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static partial class InertiaRuntimeJob {
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool member);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern IntPtr GetStdHandle(Int32 kind);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool DuplicateHandle(
    IntPtr sourceProcess, IntPtr source, IntPtr targetProcess,
    out IntPtr target, UInt32 access, bool inherit, UInt32 options
  );

  private const int TERMINAL_ADMISSION_MS = 3000;
  private const int TERMINAL_DRAIN_MS = 2000;
  private const string TERMINAL_STOPPED = "INERTIA_TERMINAL_JOB_STOPPED";

  private static bool TerminalToken(string value) {
    Guid token;
    return Guid.TryParseExact(value, "D", out token)
      && String.Equals(token.ToString("D"), value, StringComparison.Ordinal);
  }

  private static string TerminalJobName(string token) {
    return "Local\\Inertia.Terminal.Job." + token;
  }

  private static string TerminalAdmissionName(string token) {
    return "Local\\Inertia.Terminal.Admit." + token;
  }

  // The launch process belongs to the Job before it can start the shell. The
  // admission event is separate from ConPTY input: queued user input cannot
  // open it or corrupt the watcher's private control stream.
  private static int TerminalLaunch(string token, string executable, string arguments) {
    if (!TerminalToken(token) || String.IsNullOrWhiteSpace(executable)
      || executable.IndexOf('"') >= 0 || executable.IndexOf('\0') >= 0
      || executable.Length > 32767 || arguments.Length > 32767) return 24;
    IntPtr job = IntPtr.Zero;
    try {
      bool fresh;
      using (var admission = new EventWaitHandle(
        false, EventResetMode.ManualReset, TerminalAdmissionName(token), out fresh
      )) {
        if (!fresh) return Failure("terminal-admission-exists", 50, 0);
        job = CreateJobObject(IntPtr.Zero, TerminalJobName(token));
        int creationError = Marshal.GetLastWin32Error();
        if (job == IntPtr.Zero || creationError == 183) {
          return Failure("terminal-job-create", 50, creationError);
        }
        int armError;
        using (var self = Process.GetCurrentProcess()) {
          if (!ArmKillOnClose(job, out armError)
            || !AssignProcessToJobObject(job, self.Handle)) {
            return Failure("terminal-job-assign", 50, Marshal.GetLastWin32Error());
          }
        }
        if (!admission.WaitOne(TERMINAL_ADMISSION_MS)) return 50;
        // The authenticated watcher now retains the Job. It must be the sole
        // handle owner BEFORE payload creation. Watcher crash then closes the
        // last handle and kills us and all descendants, even across this race.
        CloseHandle(job);
        job = IntPtr.Zero;
        return TerminalConsolePayload(executable, arguments);
      }
    } catch { return Failure("terminal-launch", 50, 0); }
    finally { if (job != IntPtr.Zero) CloseHandle(job); }
  }

  private static int TerminalConsolePayload(string executable, string arguments) {
    var information = new PROCESS_INFORMATION();
    IntPtr attributes = IntPtr.Zero;
    IntPtr handleList = IntPtr.Zero;
    bool initialized = false;
    var handles = new IntPtr[3];
    try {
      using (var self = Process.GetCurrentProcess()) {
        for (int index = 0; index < handles.Length; index += 1) {
          if (!DuplicateHandle(self.Handle, GetStdHandle(-10 - index), self.Handle,
            out handles[index], 0, true, 2)) return Failure("terminal-console-handles", 50, Marshal.GetLastWin32Error());
        }
      }
      UIntPtr size = UIntPtr.Zero;
      InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
      if (size.ToUInt64() == 0 || size.ToUInt64() > 65536) return Failure("terminal-console-attribute-size", 50, 0);
      attributes = Marshal.AllocHGlobal((Int32)size.ToUInt64());
      if (!InitializeProcThreadAttributeList(attributes, 1, 0, ref size)) return Failure("terminal-console-attributes", 50, Marshal.GetLastWin32Error());
      initialized = true;
      handleList = Marshal.AllocHGlobal(handles.Length * IntPtr.Size);
      for (int index = 0; index < handles.Length; index += 1) {
        Marshal.WriteIntPtr(handleList, index * IntPtr.Size, handles[index]);
      }
      if (!UpdateProcThreadAttribute(attributes, 0,
        new UIntPtr(PROC_THREAD_ATTRIBUTE_HANDLE_LIST), handleList,
        new UIntPtr((UInt32)(handles.Length * IntPtr.Size)), IntPtr.Zero, IntPtr.Zero)) return Failure("terminal-console-inheritance", 50, Marshal.GetLastWin32Error());
      var startup = new STARTUPINFOEX();
      startup.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
      startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
      startup.StartupInfo.hStdInput = handles[0];
      startup.StartupInfo.hStdOutput = handles[1];
      startup.StartupInfo.hStdError = handles[2];
      startup.lpAttributeList = attributes;
      // Keep the existing ConPTY console, environment, cwd and argument bytes.
      // Only its three standard handles are inherited; never the Job or event.
      string application = executable.IndexOfAny(new char[] { '\\', '/' }) < 0 ? null : executable;
      if (!CreateProcessW(application, new StringBuilder("\"" + executable + "\" " + arguments),
        IntPtr.Zero, IntPtr.Zero, true, EXTENDED_STARTUPINFO_PRESENT,
        IntPtr.Zero, null, ref startup, out information)) return Failure("terminal-console-create", 50, Marshal.GetLastWin32Error());
      if (WaitForSingleObject(information.hProcess, INFINITE) != WAIT_OBJECT_0) return 50;
      UInt32 exitCode;
      return GetExitCodeProcess(information.hProcess, out exitCode)
        ? unchecked((Int32)exitCode) : 50;
    } finally {
      if (information.hThread != IntPtr.Zero) CloseHandle(information.hThread);
      if (information.hProcess != IntPtr.Zero) CloseHandle(information.hProcess);
      if (initialized) DeleteProcThreadAttributeList(attributes);
      if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
      if (handleList != IntPtr.Zero) Marshal.FreeHGlobal(handleList);
      foreach (IntPtr handle in handles) if (handle != IntPtr.Zero) CloseHandle(handle);
    }
  }

  private static int TerminalWatch(string[] arguments) {
    UInt32 processId, parentId;
    double earliest, latest;
    if (!TerminalToken(arguments[1])
      || !UInt32.TryParse(arguments[2], out processId) || processId <= 1 || processId > Int32.MaxValue
      || !UInt32.TryParse(arguments[3], out parentId) || parentId <= 1 || parentId > Int32.MaxValue
      || !Double.TryParse(arguments[4], NumberStyles.None, CultureInfo.InvariantCulture, out earliest)
      || !Double.TryParse(arguments[5], NumberStyles.None, CultureInfo.InvariantCulture, out latest)
      || earliest <= 0 || latest < earliest || latest - earliest > 30000) return 24;
    IntPtr job = IntPtr.Zero;
    var gate = new object();
    bool stopRequested = false;
    bool admissionRequested = false;
    var reader = new Thread(() => {
      try {
        var input = Console.OpenStandardInput();
        if (input.ReadByte() == 65) {
          lock (gate) { admissionRequested = true; }
          input.ReadByte();
        }
      } catch { }
      lock (gate) { stopRequested = true; }
    });
    reader.IsBackground = true;
    reader.Start();
    try {
      using (var guardian = Process.GetProcessById((Int32)processId)) {
        IntPtr root = guardian.Handle;
        UInt64 bits;
        double created;
        int identityError;
        var image = new StringBuilder(32768);
        UInt32 imageLength = (UInt32)image.Capacity;
        if (!ProcessIdentity(root, out bits, out created, out identityError)
          || created < earliest || created >= latest + 1
          || !ExpectedParent(processId, parentId)
          || !ExpectedParent((UInt32)Process.GetCurrentProcess().Id, parentId)
          || !QueryFullProcessImageName(root, 0, image, ref imageLength)
          || !String.Equals(image.ToString(), System.Reflection.Assembly.GetExecutingAssembly().Location,
            StringComparison.OrdinalIgnoreCase)) return Failure("terminal-watch-identity", 51, 0);
        var admissionTime = Stopwatch.StartNew();
        bool member = false;
        while (admissionTime.ElapsedMilliseconds < TERMINAL_ADMISSION_MS) {
          if (job == IntPtr.Zero) job = OpenJobObject(
            JOB_OBJECT_QUERY | JOB_OBJECT_TERMINATE, false, TerminalJobName(arguments[1])
          );
          if (job != IntPtr.Zero) {
            if (!IsProcessInJob(root, job, out member)) return 51;
            if (member) break;
          }
          if (WaitForSingleObject(root, 0) != WAIT_TIMEOUT) return 51;
          Thread.Sleep(10);
        }
        if (job == IntPtr.Zero || !member) return Failure("terminal-watch-membership", 51, 0);
        WriteProtocolLine(Console.OpenStandardOutput(), "INERTIA_TERMINAL_JOB_READY");
        using (var admission = EventWaitHandle.OpenExisting(TerminalAdmissionName(arguments[1]))) {
          while (true) {
            lock (gate) {
              if (stopRequested || WaitForSingleObject(root, 0) != WAIT_TIMEOUT) break;
              if (admissionRequested) { admission.Set(); break; }
              if (admissionTime.ElapsedMilliseconds >= TERMINAL_ADMISSION_MS) return 51;
            }
            Thread.Sleep(10);
          }
        }
        while (true) {
          bool stopping;
          lock (gate) { stopping = stopRequested; }
          UInt32 rootState = WaitForSingleObject(root, 10);
          if (stopping || rootState != WAIT_TIMEOUT) {
            // Natural shell exit also drains background descendants. Only this
            // exact retained Job is signalled, never a PID or a process snapshot.
            if (!TerminateJobObject(job, 130)) return 52;
            string stage;
            int error;
            if (DrainTerminatedJob(job, TERMINAL_DRAIN_MS, 52, out stage, out error) != 0
              || WaitForSingleObject(root, 0) != WAIT_OBJECT_0) return 52;
            WriteProtocolLine(Console.OpenStandardOutput(), TERMINAL_STOPPED);
            return 0;
          }
        }
      }
    } catch { return Failure("terminal-watch", 51, 0); }
    finally { if (job != IntPtr.Zero) CloseHandle(job); }
  }
}
