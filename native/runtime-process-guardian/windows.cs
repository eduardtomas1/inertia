using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;

public static class InertiaRuntimeJob {
  [StructLayout(LayoutKind.Sequential)]
  private struct FILETIME {
    public UInt32 dwLowDateTime;
    public UInt32 dwHighDateTime;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct IO_COUNTERS {
    public UInt64 ReadOperationCount;
    public UInt64 WriteOperationCount;
    public UInt64 OtherOperationCount;
    public UInt64 ReadTransferCount;
    public UInt64 WriteTransferCount;
    public UInt64 OtherTransferCount;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public Int64 PerProcessUserTimeLimit;
    public Int64 PerJobUserTimeLimit;
    public UInt32 LimitFlags;
    public UIntPtr MinimumWorkingSetSize;
    public UIntPtr MaximumWorkingSetSize;
    public UInt32 ActiveProcessLimit;
    public UIntPtr Affinity;
    public UInt32 PriorityClass;
    public UInt32 SchedulingClass;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
    public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit;
    public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed;
    public UIntPtr PeakJobMemoryUsed;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION {
    public Int64 TotalUserTime;
    public Int64 TotalKernelTime;
    public Int64 ThisPeriodTotalUserTime;
    public Int64 ThisPeriodTotalKernelTime;
    public UInt32 TotalPageFaultCount;
    public UInt32 TotalProcesses;
    public UInt32 ActiveProcesses;
    public UInt32 TotalTerminatedProcesses;
  }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct PROCESSENTRY32 {
    public UInt32 dwSize;
    public UInt32 cntUsage;
    public UInt32 th32ProcessID;
    public UIntPtr th32DefaultHeapID;
    public UInt32 th32ModuleID;
    public UInt32 cntThreads;
    public UInt32 th32ParentProcessID;
    public Int32 pcPriClassBase;
    public UInt32 dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
    public string szExeFile;
  }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern IntPtr OpenJobObject(UInt32 access, bool inherit, string name);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, UInt32 length);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool QueryInformationJobObject(IntPtr job, int infoClass, IntPtr info, UInt32 length, IntPtr returnedLength);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool GetProcessTimes(
    IntPtr process,
    out FILETIME creation,
    out FILETIME exit,
    out FILETIME kernel,
    out FILETIME user
  );
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool TerminateJobObject(IntPtr job, UInt32 exitCode);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern UInt32 WaitForSingleObject(IntPtr handle, UInt32 milliseconds);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern IntPtr CreateToolhelp32Snapshot(UInt32 flags, UInt32 processId);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool Process32First(IntPtr snapshot, ref PROCESSENTRY32 entry);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool Process32Next(IntPtr snapshot, ref PROCESSENTRY32 entry);

  private const UInt32 JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
  private const UInt32 JOB_OBJECT_QUERY = 0x0004;
  private const UInt32 JOB_OBJECT_TERMINATE = 0x0008;
  private const UInt32 INFINITE = 0xffffffff;
  private const UInt32 TH32CS_SNAPPROCESS = 0x00000002;
  private const Int64 MAX_EXECUTABLE_BYTES = 1024 * 1024;
  private const UInt64 WINDOWS_TO_UNIX_EPOCH_TICKS = 116444736000000000;
  private const Int32 ERROR_FILE_NOT_FOUND = 2;
  private const int JobObjectBasicAccountingInformation = 1;
  private const int JobObjectExtendedLimitInformation = 9;

  private sealed class GuardLease : IDisposable {
    private readonly object gate = new object();
    private readonly ManualResetEvent completed = new ManualResetEvent(false);
    private readonly Process process;
    private readonly IntPtr processHandle;
    private readonly Thread waiter;
    private IntPtr job;
    private int resultCode;
    private string diagnostic = "";
    private bool disposed;

    public GuardLease(IntPtr ownedJob, Process ownedProcess) {
      job = ownedJob;
      process = ownedProcess;
      processHandle = process.Handle;
      waiter = new Thread(WaitForRuntime);
      waiter.IsBackground = true;
    }

    public void Start() {
      waiter.Start();
    }

    private void Complete(int code, string detail) {
      lock (gate) {
        resultCode = code;
        diagnostic = detail;
      }
      completed.Set();
    }

    private void WaitForRuntime() {
      UInt32 waitResult = WaitForSingleObject(processHandle, INFINITE);
      if (waitResult != 0) {
        int waitError = waitResult == UInt32.MaxValue
          ? Marshal.GetLastWin32Error()
          : 0;
        Complete(14, ErrorLine("wait-process", waitError));
        return;
      }
      IntPtr currentJob;
      lock (gate) { currentJob = job; }
      if (currentJob == IntPtr.Zero) {
        Complete(16, ErrorLine("job-lease-closed", 0));
        return;
      }
      if (!TerminateJobObject(currentJob, 137)) {
        Complete(15, ErrorLine("terminate-job", Marshal.GetLastWin32Error()));
        return;
      }
      for (int index = 0; index < 200 && ActiveProcesses(currentJob) != 0; index += 1) {
        Thread.Sleep(10);
      }
      if (ActiveProcesses(currentJob) != 0) {
        Complete(16, ErrorLine("drain-job", 0));
        return;
      }
      Complete(0, "");
    }

    public bool IsCompleted {
      get { return completed.WaitOne(0); }
    }

    public int ResultCode {
      get { lock (gate) { return resultCode; } }
    }

    public string Diagnostic {
      get { lock (gate) { return diagnostic; } }
    }

    public bool RequestStop(out string detail) {
      lock (gate) {
        if (disposed) {
          detail = ErrorLine("job-lease-closed", 0);
          return false;
        }
        if (completed.WaitOne(0)) {
          detail = diagnostic;
          return resultCode == 0;
        }
        if (job == IntPtr.Zero || !TerminateJobObject(job, 137)) {
          detail = ErrorLine("terminate-job", Marshal.GetLastWin32Error());
          return false;
        }
        detail = "";
        return true;
      }
    }

    public bool WaitForCompletion(int timeoutMilliseconds) {
      return completed.WaitOne(Math.Max(0, timeoutMilliseconds));
    }

    public void Dispose() {
      lock (gate) {
        if (disposed) return;
        if (!completed.WaitOne(0)) {
          throw new InvalidOperationException("The Windows runtime Job lease is still active.");
        }
        disposed = true;
        process.Dispose();
        if (job != IntPtr.Zero) {
          CloseHandle(job);
          job = IntPtr.Zero;
        }
        completed.Dispose();
      }
    }
  }

  private static readonly object LeaseGate = new object();
  private static readonly Dictionary<string, GuardLease> GuardLeases =
    new Dictionary<string, GuardLease>(StringComparer.Ordinal);

  private static bool FixedTimeEquals(byte[] left, byte[] right) {
    if (left.Length != right.Length) return false;
    int difference = 0;
    for (int index = 0; index < left.Length; index += 1) {
      difference |= left[index] ^ right[index];
    }
    return difference == 0;
  }

  private static FileStream OpenVerifiedExecutable(string expectedDigest) {
    if (expectedDigest == null || expectedDigest.Length != 64) return null;
    byte[] expected = new byte[32];
    for (int index = 0; index < expected.Length; index += 1) {
      byte value;
      if (!Byte.TryParse(
        expectedDigest.Substring(index * 2, 2),
        NumberStyles.AllowHexSpecifier,
        CultureInfo.InvariantCulture,
        out value
      )) return null;
      expected[index] = value;
    }
    string path = typeof(InertiaRuntimeJob).Assembly.Location;
    var metadata = new FileInfo(path);
    if (!metadata.Exists || metadata.Length <= 0 || metadata.Length > MAX_EXECUTABLE_BYTES) {
      return null;
    }
    FileStream stream = null;
    try {
      stream = new FileStream(
        path,
        FileMode.Open,
        FileAccess.Read,
        FileShare.Read
      );
      using (var sha256 = SHA256.Create()) {
        if (stream.Length != metadata.Length) {
          stream.Dispose();
          return null;
        }
        byte[] actual = sha256.ComputeHash(stream);
        if (stream.Position != stream.Length || !FixedTimeEquals(actual, expected)) {
          stream.Dispose();
          return null;
        }
      }
      return stream;
    } catch {
      if (stream != null) stream.Dispose();
      return null;
    }
  }

  private static void WriteProtocolLine(Stream stream, string value) {
    byte[] bytes = Encoding.UTF8.GetBytes(value + "\n");
    stream.Write(bytes, 0, bytes.Length);
    stream.Flush();
  }

  private static string ErrorLine(string stage, int win32Error) {
    return "INERTIA_JOB_ERROR stage=" + stage + " win32=" + win32Error;
  }

  private static int Failure(string stage, int exitCode, int win32Error) {
    WriteProtocolLine(
      Console.OpenStandardError(),
      ErrorLine(stage, win32Error)
    );
    return exitCode;
  }

  private static void Stage(string stage) {
    WriteProtocolLine(
      Console.OpenStandardError(),
      "INERTIA_JOB_STAGE stage=" + stage
    );
  }

  private static bool ArmKillOnClose(IntPtr job, out int win32Error) {
    var information = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
    information.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    int length = Marshal.SizeOf(information);
    IntPtr pointer = Marshal.AllocHGlobal(length);
    try {
      Marshal.StructureToPtr(information, pointer, false);
      bool armed = SetInformationJobObject(
        job,
        JobObjectExtendedLimitInformation,
        pointer,
        (UInt32)length
      );
      win32Error = armed ? 0 : Marshal.GetLastWin32Error();
      return armed;
    } finally {
      Marshal.FreeHGlobal(pointer);
    }
  }

  private static UInt32 ActiveProcesses(IntPtr job) {
    int length = Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION));
    IntPtr pointer = Marshal.AllocHGlobal(length);
    try {
      if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation, pointer, (UInt32)length, IntPtr.Zero)) {
        return UInt32.MaxValue;
      }
      return ((JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)Marshal.PtrToStructure(
        pointer,
        typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)
      )).ActiveProcesses;
    } finally {
      Marshal.FreeHGlobal(pointer);
    }
  }

  private static int CreationIdentityStatus(
    IntPtr process,
    UInt64 expectedCreationTimeBits,
    out int win32Error
  ) {
    FILETIME creation;
    FILETIME exit;
    FILETIME kernel;
    FILETIME user;
    if (!GetProcessTimes(process, out creation, out exit, out kernel, out user)) {
      win32Error = Marshal.GetLastWin32Error();
      return 1;
    }
    UInt64 ticks = ((UInt64)creation.dwHighDateTime << 32)
      | creation.dwLowDateTime;
    win32Error = 0;
    if (ticks < WINDOWS_TO_UNIX_EPOCH_TICKS) return 2;
    UInt64 unixMicroseconds = (ticks / 10)
      - (WINDOWS_TO_UNIX_EPOCH_TICKS / 10);
    double actualCreationTimeMs = (double)unixMicroseconds / 1000.0;
    UInt64 actualCreationTimeBits = unchecked(
      (UInt64)BitConverter.DoubleToInt64Bits(actualCreationTimeMs)
    );
    return actualCreationTimeBits == expectedCreationTimeBits ? 0 : 2;
  }

  private static bool ProcessIdentity(
    IntPtr process,
    out UInt64 creationBits,
    out double creationTimeMs,
    out int win32Error
  ) {
    FILETIME creation;
    FILETIME exit;
    FILETIME kernel;
    FILETIME user;
    creationBits = 0;
    creationTimeMs = 0;
    if (!GetProcessTimes(process, out creation, out exit, out kernel, out user)) {
      win32Error = Marshal.GetLastWin32Error();
      return false;
    }
    UInt64 ticks = ((UInt64)creation.dwHighDateTime << 32)
      | creation.dwLowDateTime;
    if (ticks < WINDOWS_TO_UNIX_EPOCH_TICKS) {
      win32Error = 0;
      return false;
    }
    UInt64 unixMicroseconds = (ticks / 10)
      - (WINDOWS_TO_UNIX_EPOCH_TICKS / 10);
    creationTimeMs = (double)unixMicroseconds / 1000.0;
    creationBits = unchecked(
      (UInt64)BitConverter.DoubleToInt64Bits(creationTimeMs)
    );
    win32Error = 0;
    return true;
  }

  private static bool ExpectedParent(UInt32 processId, UInt32 expectedParent) {
    IntPtr snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snapshot == new IntPtr(-1)) return false;
    try {
      PROCESSENTRY32 entry = new PROCESSENTRY32();
      entry.dwSize = (UInt32)Marshal.SizeOf(typeof(PROCESSENTRY32));
      if (!Process32First(snapshot, ref entry)) return false;
      do {
        if (entry.th32ProcessID == processId) {
          return entry.th32ParentProcessID == expectedParent;
        }
      } while (Process32Next(snapshot, ref entry));
      return false;
    } finally {
      CloseHandle(snapshot);
    }
  }

  private static bool PruneCompletedLeases(out string diagnostic) {
    var completedNames = new List<string>();
    var completedLeases = new List<GuardLease>();
    diagnostic = "";
    lock (LeaseGate) {
      foreach (KeyValuePair<string, GuardLease> entry in GuardLeases) {
        if (!entry.Value.IsCompleted) continue;
        if (entry.Value.ResultCode != 0) {
          diagnostic = entry.Value.Diagnostic;
          return false;
        }
        completedNames.Add(entry.Key);
        completedLeases.Add(entry.Value);
      }
      foreach (string name in completedNames) GuardLeases.Remove(name);
    }
    foreach (GuardLease lease in completedLeases) lease.Dispose();
    return true;
  }

  public static int BeginGuard(
    string name,
    string processIdValue,
    string expectedCreationTimeBitsValue,
    out string diagnostic
  ) {
    diagnostic = "";
    UInt32 processId;
    UInt64 expectedCreationTimeBits;
    if (!UInt32.TryParse(
      processIdValue,
      NumberStyles.None,
      CultureInfo.InvariantCulture,
      out processId
    ) || processId <= 1 || processId > Int32.MaxValue) {
      diagnostic = ErrorLine("capture-process-handle", 0);
      return 12;
    }
    if (!UInt64.TryParse(
      expectedCreationTimeBitsValue,
      NumberStyles.None,
      CultureInfo.InvariantCulture,
      out expectedCreationTimeBits
    )) {
      diagnostic = ErrorLine("process-identity-invalid", 0);
      return 19;
    }
    if (!PruneCompletedLeases(out diagnostic)) return 27;
    lock (LeaseGate) {
      if (GuardLeases.Count >= 8) {
        diagnostic = ErrorLine("guardian-limit", 0);
        return 27;
      }
    }

    Process process = null;
    IntPtr job = IntPtr.Zero;
    GuardLease lease = null;
    bool leaseStarted = false;
    try {
      try {
        process = Process.GetProcessById((Int32)processId);
        IntPtr processHandle = process.Handle;
        int identityError;
        int identityStatus = CreationIdentityStatus(
          processHandle,
          expectedCreationTimeBits,
          out identityError
        );
        if (identityStatus == 1) {
          diagnostic = ErrorLine("read-process-identity", identityError);
          return 12;
        }
        if (identityStatus == 2) {
          diagnostic = ErrorLine("process-identity-mismatch", 0);
          return 18;
        }
        job = CreateJobObject(IntPtr.Zero, name);
        int createError = Marshal.GetLastWin32Error();
        if (job == IntPtr.Zero) {
          diagnostic = ErrorLine("create-job", createError);
          return 10;
        }
        if (createError == 183) {
          diagnostic = ErrorLine("create-job-existing", createError);
          return 17;
        }
        int armError;
        if (!ArmKillOnClose(job, out armError)) {
          diagnostic = ErrorLine("set-kill-on-close", armError);
          return 11;
        }
        if (!AssignProcessToJobObject(job, processHandle)) {
          diagnostic = ErrorLine("assign-process", Marshal.GetLastWin32Error());
          return 13;
        }
      } catch {
        diagnostic = ErrorLine("capture-process-handle", 0);
        return 12;
      }

      lease = new GuardLease(job, process);
      lease.Start();
      leaseStarted = true;
      job = IntPtr.Zero;
      process = null;
      lock (LeaseGate) {
        if (GuardLeases.ContainsKey(name)) {
          diagnostic = ErrorLine("create-job-existing", 183);
          return 17;
        }
        GuardLeases.Add(name, lease);
      }
      lease = null;
      return 0;
    } finally {
      if (lease != null && leaseStarted) {
        string ignored;
        lease.RequestStop(out ignored);
        if (lease.WaitForCompletion(2000)) lease.Dispose();
      }
      if (job != IntPtr.Zero) CloseHandle(job);
      if (process != null) process.Dispose();
    }
  }

  public static int RecoverManaged(string name) {
    string ignored;
    if (!PruneCompletedLeases(out ignored)) return 27;
    IntPtr job = OpenJobObject(JOB_OBJECT_QUERY | JOB_OBJECT_TERMINATE, false, name);
    if (job == IntPtr.Zero) {
      return Marshal.GetLastWin32Error() == ERROR_FILE_NOT_FOUND ? 0 : 22;
    }
    try {
      if (!TerminateJobObject(job, 137)) return 20;
      for (int index = 0; index < 200 && ActiveProcesses(job) != 0; index += 1) {
        Thread.Sleep(10);
      }
      return ActiveProcesses(job) == 0 ? 0 : 21;
    } finally {
      CloseHandle(job);
    }
  }

  public static int ShutdownAll(int timeoutMilliseconds, out string diagnostic) {
    diagnostic = "";
    var deadline = Stopwatch.StartNew();
    GuardLease[] leases;
    lock (LeaseGate) {
      leases = new GuardLease[GuardLeases.Count];
      GuardLeases.Values.CopyTo(leases, 0);
    }
    bool stopped = true;
    foreach (GuardLease lease in leases) {
      string detail;
      if (!lease.RequestStop(out detail)) {
        stopped = false;
        if (diagnostic.Length == 0) diagnostic = detail;
      }
    }
    foreach (GuardLease lease in leases) {
      int remaining = Math.Max(
        0,
        timeoutMilliseconds - (Int32)deadline.ElapsedMilliseconds
      );
      if (!lease.WaitForCompletion(remaining)) {
        stopped = false;
        if (diagnostic.Length == 0) {
          diagnostic = ErrorLine("guardian-exit-unconfirmed", 0);
        }
      } else if (lease.ResultCode != 0) {
        stopped = false;
        if (diagnostic.Length == 0) diagnostic = lease.Diagnostic;
      }
    }
    if (!stopped) return 27;
    lock (LeaseGate) {
      foreach (GuardLease lease in leases) {
        string matchingName = null;
        foreach (KeyValuePair<string, GuardLease> entry in GuardLeases) {
          if (Object.ReferenceEquals(entry.Value, lease)) {
            matchingName = entry.Key;
            break;
          }
        }
        if (matchingName != null) GuardLeases.Remove(matchingName);
      }
    }
    foreach (GuardLease lease in leases) lease.Dispose();
    return 0;
  }

  public static int Guard(
    string name,
    IntPtr process,
    string expectedCreationTimeBitsValue
  ) {
    Stage("native-guard-start");
    UInt64 expectedCreationTimeBits;
    if (!UInt64.TryParse(
      expectedCreationTimeBitsValue,
      NumberStyles.None,
      CultureInfo.InvariantCulture,
      out expectedCreationTimeBits
    )) {
      return Failure("process-identity-invalid", 19, 0);
    }
    int identityError;
    int identityStatus = CreationIdentityStatus(
      process,
      expectedCreationTimeBits,
      out identityError
    );
    if (identityStatus == 1) {
      return Failure("read-process-identity", 12, identityError);
    }
    if (identityStatus == 2) {
      return Failure("process-identity-mismatch", 18, 0);
    }
    IntPtr job = CreateJobObject(IntPtr.Zero, name);
    int createError = Marshal.GetLastWin32Error();
    if (job == IntPtr.Zero) return Failure("create-job", 10, createError);
    if (createError == 183) {
      CloseHandle(job);
      return Failure("create-job-existing", 17, createError);
    }
    try {
      int armError;
      if (!ArmKillOnClose(job, out armError)) {
        return Failure("set-kill-on-close", 11, armError);
      }
      if (!AssignProcessToJobObject(job, process)) {
        return Failure("assign-process", 13, Marshal.GetLastWin32Error());
      }
      IntPtr brokerJob = OpenJobObject(
        JOB_OBJECT_QUERY | JOB_OBJECT_TERMINATE,
        false,
        name
      );
      if (brokerJob == IntPtr.Zero) {
        return Failure("open-job-watch", 26, Marshal.GetLastWin32Error());
      }
      // The launch broker is the only owner of stdin. Unexpected broker exit
      // closes the pipe, so the guardian must immediately terminate the Job
      // instead of becoming an unowned background process. The watcher owns a
      // distinct Job handle, avoiding a close/use race with Guard's handle.
      var brokerWatcher = new Thread(delegate() {
        try {
          try {
            while (Console.In.Read() != -1) {}
          } catch {}
          TerminateJobObject(brokerJob, 137);
        } finally {
          CloseHandle(brokerJob);
        }
      });
      brokerWatcher.IsBackground = true;
      brokerWatcher.Start();
      if (
        Environment.GetEnvironmentVariable("NODE_ENV") == "test" &&
        Environment.GetEnvironmentVariable(
          "INERTIA_TEST_WINDOWS_GUARDIAN_HANG_BEFORE_READY"
        ) == "1"
      ) {
        Thread.Sleep(5000);
      }
      // Write the private readiness protocol to the native stream so Node
      // always receives the bounded UTF-8 marker it parses on every build.
      WriteProtocolLine(Console.OpenStandardOutput(), "READY");
      UInt32 waitResult = WaitForSingleObject(process, INFINITE);
      if (waitResult != 0) {
        int waitError = waitResult == UInt32.MaxValue
          ? Marshal.GetLastWin32Error()
          : 0;
        return Failure("wait-process", 14, waitError);
      }
      UInt32 residualProcesses = ActiveProcesses(job);
      if (residualProcesses == UInt32.MaxValue) {
        return Failure("query-job", 29, Marshal.GetLastWin32Error());
      }
      if (!TerminateJobObject(job, 137)) {
        return Failure("terminate-job", 15, Marshal.GetLastWin32Error());
      }
      for (int index = 0; index < 200 && ActiveProcesses(job) != 0; index += 1) {
        System.Threading.Thread.Sleep(10);
      }
      if (ActiveProcesses(job) != 0) return 16;
      return residualProcesses == 0 ? 0 : 28;
    } finally {
      CloseHandle(job);
    }
  }

  public static int GuardOwned(
    string name,
    string processIdValue,
    string expectedParentValue,
    string earliestCreationTimeMsValue
  ) {
    UInt32 processId;
    UInt32 expectedParent;
    double earliestCreationTimeMs;
    if (
      !UInt32.TryParse(processIdValue, NumberStyles.None,
        CultureInfo.InvariantCulture, out processId)
      || processId <= 1
      || processId > Int32.MaxValue
      || !UInt32.TryParse(expectedParentValue, NumberStyles.None,
        CultureInfo.InvariantCulture, out expectedParent)
      || expectedParent <= 1
      || expectedParent > Int32.MaxValue
      || !Double.TryParse(earliestCreationTimeMsValue,
        NumberStyles.AllowDecimalPoint,
        CultureInfo.InvariantCulture,
        out earliestCreationTimeMs)
      || earliestCreationTimeMs <= 0
      || !ExpectedParent(processId, expectedParent)
    ) return Failure("owned-process-identity", 30, 0);
    Process process = null;
    try {
      process = Process.GetProcessById((Int32)processId);
      UInt64 creationBits;
      double creationTimeMs;
      int identityError;
      if (!ProcessIdentity(
        process.Handle,
        out creationBits,
        out creationTimeMs,
        out identityError
      ) || creationTimeMs < earliestCreationTimeMs) {
        return Failure("owned-process-identity", 30, identityError);
      }
      return Guard(
        name,
        process.Handle,
        creationBits.ToString(CultureInfo.InvariantCulture)
      );
    } catch {
      return Failure("capture-process-handle", 12, 0);
    } finally {
      if (process != null) process.Dispose();
    }
  }

  public static int Recover(string name) {
    IntPtr job = OpenJobObject(JOB_OBJECT_QUERY | JOB_OBJECT_TERMINATE, false, name);
    if (job == IntPtr.Zero) {
      if (Marshal.GetLastWin32Error() != ERROR_FILE_NOT_FOUND) return 22;
      WriteProtocolLine(Console.OpenStandardOutput(), "ABSENT");
      return 0;
    }
    try {
      if (!TerminateJobObject(job, 137)) return 20;
      for (int index = 0; index < 200 && ActiveProcesses(job) != 0; index += 1) {
        System.Threading.Thread.Sleep(10);
      }
      return ActiveProcesses(job) == 0 ? 0 : 21;
    } finally {
      CloseHandle(job);
    }
  }

  public static int Main(string[] arguments) {
    if (
      arguments == null
      || arguments.Length < 3
    ) return Failure("self-integrity", 23, 0);
    using (var executable = OpenVerifiedExecutable(arguments[arguments.Length - 1])) {
      if (executable == null) return Failure("self-integrity", 23, 0);
      if (String.Equals(arguments[0], "recover", StringComparison.Ordinal)) {
        return arguments.Length == 3 ? Recover(arguments[1]) : 24;
      }
      if (String.Equals(arguments[0], "guard-owned", StringComparison.Ordinal)) {
        return arguments.Length == 6
          ? GuardOwned(arguments[1], arguments[2], arguments[3], arguments[4])
          : 24;
      }
      if (!String.Equals(arguments[0], "guard", StringComparison.Ordinal)
        || arguments.Length != 5) return 24;
      UInt32 processId;
      if (!UInt32.TryParse(
        arguments[2],
        NumberStyles.None,
        CultureInfo.InvariantCulture,
        out processId
      ) || processId <= 1 || processId > Int32.MaxValue) {
        return Failure("capture-process-handle", 12, 0);
      }
      Process process = null;
      try {
        process = Process.GetProcessById((Int32)processId);
        IntPtr handle = process.Handle;
        return Guard(arguments[1], handle, arguments[3]);
      } catch {
        return Failure("capture-process-handle", 12, 0);
      } finally {
        if (process != null) process.Dispose();
      }
    }
  }
}
