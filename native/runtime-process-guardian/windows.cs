using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

public static class InertiaRuntimeJob {
  [StructLayout(LayoutKind.Sequential)]
  private struct STARTUPINFO {
    public Int32 cb;
    public IntPtr lpReserved, lpDesktop, lpTitle;
    public UInt32 dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars;
    public UInt32 dwFillAttribute, dwFlags;
    public UInt16 wShowWindow, cbReserved2;
    public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct STARTUPINFOEX {
    public STARTUPINFO StartupInfo;
    public IntPtr lpAttributeList;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct PROCESS_INFORMATION {
    public IntPtr hProcess, hThread;
    public UInt32 dwProcessId, dwThreadId;
  }

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

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct SHELLEXECUTEINFO {
    public Int32 cbSize;
    public UInt32 fMask;
    public IntPtr hwnd;
    [MarshalAs(UnmanagedType.LPWStr)] public string lpVerb;
    [MarshalAs(UnmanagedType.LPWStr)] public string lpFile;
    [MarshalAs(UnmanagedType.LPWStr)] public string lpParameters;
    [MarshalAs(UnmanagedType.LPWStr)] public string lpDirectory;
    public Int32 nShow;
    public IntPtr hInstApp;
    public IntPtr lpIDList;
    [MarshalAs(UnmanagedType.LPWStr)] public string lpClass;
    public IntPtr hkeyClass;
    public UInt32 dwHotKey;
    public IntPtr hIconOrMonitor;
    public IntPtr hProcess;
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
  private static extern bool InitializeProcThreadAttributeList(
    IntPtr attributes, Int32 count, UInt32 flags, ref UIntPtr size
  );
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool UpdateProcThreadAttribute(
    IntPtr attributes, UInt32 flags, UIntPtr attribute,
    IntPtr value, UIntPtr size, IntPtr previousValue, IntPtr returnSize
  );
  [DllImport("kernel32.dll")]
  private static extern void DeleteProcThreadAttributeList(IntPtr attributes);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CreateProcessW(
    string applicationName, StringBuilder commandLine,
    IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles,
    UInt32 creationFlags, IntPtr environment, string currentDirectory,
    ref STARTUPINFOEX startupInfo, out PROCESS_INFORMATION processInformation
  );
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool TerminateProcess(IntPtr process, UInt32 exitCode);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern IntPtr CreateToolhelp32Snapshot(UInt32 flags, UInt32 processId);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool Process32First(IntPtr snapshot, ref PROCESSENTRY32 entry);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool Process32Next(IntPtr snapshot, ref PROCESSENTRY32 entry);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool QueryFullProcessImageName(
    IntPtr process,
    UInt32 flags,
    StringBuilder executableName,
    ref UInt32 size
  );
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool GetExitCodeProcess(IntPtr process, out UInt32 exitCode);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern IntPtr CreateFile(
    string fileName,
    UInt32 desiredAccess,
    UInt32 shareMode,
    IntPtr securityAttributes,
    UInt32 creationDisposition,
    UInt32 flagsAndAttributes,
    IntPtr templateFile
  );
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool SetFileInformationByHandle(
    IntPtr file,
    Int32 fileInformationClass,
    IntPtr fileInformation,
    UInt32 bufferSize
  );
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool ShellExecuteEx(ref SHELLEXECUTEINFO execute);

  private const UInt32 JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
  private const UInt32 JOB_OBJECT_QUERY = 0x0004;
  private const UInt32 JOB_OBJECT_TERMINATE = 0x0008;
  private const UInt32 INFINITE = 0xffffffff;
  private const UInt32 TH32CS_SNAPPROCESS = 0x00000002;
  private const UInt32 SEE_MASK_NOCLOSEPROCESS = 0x00000040;
  private const UInt32 SEE_MASK_NOASYNC = 0x00000100;
  private const UInt32 WAIT_OBJECT_0 = 0x00000000;
  private const UInt32 WAIT_TIMEOUT = 0x00000102;
  private const UInt32 STILL_ACTIVE = 259;
  private const UInt32 GENERIC_READ = 0x80000000;
  private const UInt32 GENERIC_WRITE = 0x40000000;
  private const UInt32 DELETE_ACCESS = 0x00010000;
  private const UInt32 CREATE_NEW_FILE = 1;
  private const UInt32 FILE_ATTRIBUTE_NORMAL = 0x00000080;
  private const UInt32 FILE_FLAG_WRITE_THROUGH = 0x80000000;
  private const UInt32 STARTF_USESTDHANDLES = 0x00000100;
  private const UInt32 EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
  private const UInt32 CREATE_NO_WINDOW = 0x08000000;
  private const UInt32 PROC_THREAD_ATTRIBUTE_HANDLE_LIST = 0x00020002;
  private const Int32 FileRenameInfo = 3;
  private const Int64 MAX_EXECUTABLE_BYTES = 1024 * 1024;
  private const Int64 MAX_UPDATE_ARTIFACT_BYTES = 1024L * 1024L * 1024L;
  private const Int32 MAX_UPDATE_REQUEST_BYTES = 64 * 1024;
  private const Int32 MAX_UPDATE_PATH_BYTES = 4 * 1024;
  private const Int32 MAX_UPDATE_READY_BYTES = 32;
  private const Int32 UPDATE_LAUNCH_CLEANUP_UNCONFIRMED = 47;
  private const UInt64 WINDOWS_TO_UNIX_EPOCH_TICKS = 116444736000000000;
  private const Int32 ERROR_FILE_NOT_FOUND = 2;
  private const int JobObjectBasicAccountingInformation = 1;
  private const int JobObjectExtendedLimitInformation = 9;
  private const int JOB_DRAIN_POLL_MS = 10;
  private const int GUARD_LEASE_JOB_DRAIN_TIMEOUT_MS = 2500;
  private const int RECOVERY_JOB_DRAIN_TIMEOUT_MS = 5000;

  private sealed class GuardLease : IDisposable {
    private readonly object gate = new object();
    private readonly ManualResetEvent completed = new ManualResetEvent(false);
    private readonly Process process;
    private readonly IntPtr processHandle;
    private readonly Thread waiter;
    private IntPtr job;
    private int resultCode;
    private string diagnostic = "";
    private bool recoveryConfirmed;
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
        resultCode = recoveryConfirmed ? 0 : code;
        diagnostic = recoveryConfirmed ? "" : detail;
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
      string failureStage;
      int win32Error;
      int drainResult = DrainTerminatedJob(
        currentJob,
        GUARD_LEASE_JOB_DRAIN_TIMEOUT_MS,
        16,
        out failureStage,
        out win32Error
      );
      Complete(
        drainResult,
        drainResult == 0 ? "" : ErrorLine(failureStage, win32Error)
      );
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
        if (recoveryConfirmed) {
          detail = "";
          return true;
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

    public void ConfirmRecovery() {
      lock (gate) {
        if (disposed) return;
        recoveryConfirmed = true;
        resultCode = 0;
        diagnostic = "";
      }
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

  private static bool TryActiveProcesses(
    IntPtr job,
    out UInt32 activeProcesses,
    out int win32Error
  ) {
    int length = Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION));
    IntPtr pointer = Marshal.AllocHGlobal(length);
    try {
      if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation, pointer, (UInt32)length, IntPtr.Zero)) {
        activeProcesses = 0;
        win32Error = Marshal.GetLastWin32Error();
        return false;
      }
      activeProcesses = ((JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)Marshal.PtrToStructure(
        pointer,
        typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)
      )).ActiveProcesses;
      win32Error = 0;
      return true;
    } finally {
      Marshal.FreeHGlobal(pointer);
    }
  }

  private static int DrainTerminatedJob(
    IntPtr job,
    int timeoutMilliseconds,
    int timeoutCode,
    out string failureStage,
    out int win32Error
  ) {
    failureStage = "";
    win32Error = 0;
    var elapsed = Stopwatch.StartNew();
    int boundedTimeout = Math.Max(1, timeoutMilliseconds);
    while (true) {
      UInt32 activeProcesses;
      int queryError;
      if (!TryActiveProcesses(job, out activeProcesses, out queryError)) {
        failureStage = "query-job";
        win32Error = queryError;
        return 29;
      }
      if (activeProcesses == 0) return 0;
      int remaining = boundedTimeout - (Int32)elapsed.ElapsedMilliseconds;
      if (remaining <= 0) {
        failureStage = "drain-job";
        return timeoutCode;
      }
      Thread.Sleep(Math.Min(JOB_DRAIN_POLL_MS, remaining));
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

  public static int RecoverManaged(
    string name,
    int timeoutMilliseconds,
    out string diagnostic
  ) {
    diagnostic = "";
    IntPtr job = OpenJobObject(JOB_OBJECT_QUERY | JOB_OBJECT_TERMINATE, false, name);
    if (job == IntPtr.Zero) {
      int openError = Marshal.GetLastWin32Error();
      if (openError == ERROR_FILE_NOT_FOUND) return 0;
      diagnostic = ErrorLine("open-job", openError);
      return 22;
    }
    try {
      if (!TerminateJobObject(job, 137)) {
        diagnostic = ErrorLine("terminate-job", Marshal.GetLastWin32Error());
        return 20;
      }
      string failureStage;
      int win32Error;
      int result = DrainTerminatedJob(
        job,
        Math.Min(
          Math.Max(1, timeoutMilliseconds),
          RECOVERY_JOB_DRAIN_TIMEOUT_MS
        ),
        21,
        out failureStage,
        out win32Error
      );
      if (result != 0) {
        diagnostic = ErrorLine(failureStage, win32Error);
        return result;
      }
      GuardLease lease = null;
      lock (LeaseGate) {
        GuardLeases.TryGetValue(name, out lease);
      }
      if (lease != null) lease.ConfirmRecovery();
      return 0;
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
      UInt32 residualProcesses;
      int queryError;
      if (!TryActiveProcesses(job, out residualProcesses, out queryError)) {
        return Failure("query-job", 29, queryError);
      }
      if (!TerminateJobObject(job, 137)) {
        return Failure("terminate-job", 15, Marshal.GetLastWin32Error());
      }
      string drainFailureStage;
      int drainWin32Error;
      int drainResult = DrainTerminatedJob(
        job,
        2000,
        16,
        out drainFailureStage,
        out drainWin32Error
      );
      if (drainResult != 0) {
        return Failure(
          drainFailureStage,
          drainResult,
          drainWin32Error
        );
      }
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
      string failureStage;
      int win32Error;
      return DrainTerminatedJob(
        job,
        2000,
        21,
        out failureStage,
        out win32Error
      );
    } finally {
      CloseHandle(job);
    }
  }

  private sealed class UpdateSupervisorRequest {
    public string OperationId;
    public string HandoffChecksum;
    public string LaunchId;
    public UInt32 ParentProcessId;
    public string InstallerPath;
    public string InstallerDigest;
    public string OldExecutablePath;
    public string OldExecutableDigest;
    public string NewExecutablePath;
    public string NewExecutableDigest;
    public string ReceiptPath;
    public string ReceiptTemporaryPath;
    public string SupervisorDigest;
    public string HandoffToken;
    public string DeadlineAtText;
    public DateTimeOffset DeadlineAt;
  }

  private sealed class UpdateDeadline {
    private readonly DateTimeOffset startedAt;
    private readonly double budgetMilliseconds;
    private readonly Stopwatch elapsed;

    private UpdateDeadline(
      DateTimeOffset initialTime,
      double initialBudgetMilliseconds
    ) {
      startedAt = initialTime;
      budgetMilliseconds = initialBudgetMilliseconds;
      elapsed = Stopwatch.StartNew();
    }

    public static UpdateDeadline Start(DateTimeOffset deadlineAt) {
      DateTimeOffset initialTime = DateTimeOffset.UtcNow;
      double budget = (deadlineAt - initialTime).TotalMilliseconds;
      if (budget <= 0 || budget > TimeSpan.FromHours(24).TotalMilliseconds) {
        return null;
      }
      return new UpdateDeadline(initialTime, budget);
    }

    public UInt32 RemainingMilliseconds() {
      double remaining = budgetMilliseconds - elapsed.Elapsed.TotalMilliseconds;
      if (remaining <= 0) return 0;
      return (UInt32)Math.Min(
        Math.Ceiling(remaining),
        (double)Int32.MaxValue
      );
    }

    public bool Expired {
      get { return elapsed.Elapsed.TotalMilliseconds >= budgetMilliseconds; }
    }

    public DateTimeOffset CurrentTime {
      get { return startedAt.Add(elapsed.Elapsed); }
    }
  }

  private static string BytesToHex(byte[] bytes) {
    var value = new StringBuilder(bytes.Length * 2);
    for (int index = 0; index < bytes.Length; index += 1) {
      value.Append(bytes[index].ToString("x2", CultureInfo.InvariantCulture));
    }
    return value.ToString();
  }

  private static bool ValidDigest(string value) {
    if (value == null || value.Length != 64) return false;
    for (int index = 0; index < value.Length; index += 1) {
      char current = value[index];
      if (!((current >= '0' && current <= '9')
        || (current >= 'a' && current <= 'f'))) return false;
    }
    return true;
  }

  private static bool ValidToken(string value) {
    if (value == null || value.Length != 43) return false;
    for (int index = 0; index < value.Length; index += 1) {
      char current = value[index];
      if (!((current >= '0' && current <= '9')
        || (current >= 'A' && current <= 'Z')
        || (current >= 'a' && current <= 'z')
        || current == '_'
        || current == '-')) return false;
    }
    return true;
  }

  private static bool ValidOperationId(string value) {
    Guid parsed;
    return value != null
      && value.Length == 36
      && Guid.TryParseExact(value, "D", out parsed)
      && String.Equals(
        parsed.ToString("D"),
        value,
        StringComparison.Ordinal
      );
  }

  private static string DecodeUpdateField(string line, string name) {
    string prefix = name + "=";
    if (line == null || !line.StartsWith(prefix, StringComparison.Ordinal)) {
      return null;
    }
    string encoded = line.Substring(prefix.Length);
    if (encoded.Length == 0 || encoded.Length > MAX_UPDATE_PATH_BYTES * 2) {
      return null;
    }
    try {
      byte[] bytes = Convert.FromBase64String(encoded);
      if (!String.Equals(
        Convert.ToBase64String(bytes),
        encoded,
        StringComparison.Ordinal
      )) return null;
      string value = new UTF8Encoding(false, true).GetString(bytes);
      return value.IndexOf('\0') < 0 ? value : null;
    } catch {
      return null;
    }
  }

  private static string ReadBoundedUpdateRequest() {
    Stream input = Console.OpenStandardInput();
    var bytes = new byte[MAX_UPDATE_REQUEST_BYTES + 1];
    int offset = 0;
    while (offset < bytes.Length) {
      int count = input.Read(bytes, offset, bytes.Length - offset);
      if (count == 0) break;
      offset += count;
    }
    if (offset == 0 || offset > MAX_UPDATE_REQUEST_BYTES) return null;
    try {
      return new UTF8Encoding(false, true).GetString(bytes, 0, offset);
    } catch {
      return null;
    }
  }

  private static string ExactFullPath(string value) {
    if (
      value == null
      || value.Length == 0
      || Encoding.UTF8.GetByteCount(value) > MAX_UPDATE_PATH_BYTES
      || !Path.IsPathRooted(value)
    ) return null;
    try {
      string normalized = Path.GetFullPath(value);
      return String.Equals(normalized, value, StringComparison.OrdinalIgnoreCase)
        ? normalized
        : null;
    } catch {
      return null;
    }
  }

  private static string OperationHash(string operationId) {
    using (var sha256 = SHA256.Create()) {
      return BytesToHex(sha256.ComputeHash(Encoding.UTF8.GetBytes(operationId)));
    }
  }

  private static bool DirectDirectory(string path) {
    try {
      var directory = new DirectoryInfo(path);
      return directory.Exists
        && (directory.Attributes & FileAttributes.ReparsePoint) == 0;
    } catch {
      return false;
    }
  }

  private static bool OutsideInstallTree(
    string helperPath,
    string executablePath
  ) {
    try {
      string helperDirectory = Path.GetDirectoryName(helperPath);
      string installDirectory = Path.GetDirectoryName(executablePath);
      if (helperDirectory == null || installDirectory == null) return false;
      string installPrefix = installDirectory.TrimEnd(
        Path.DirectorySeparatorChar,
        Path.AltDirectorySeparatorChar
      ) + Path.DirectorySeparatorChar;
      return !String.Equals(
          helperDirectory,
          installDirectory,
          StringComparison.OrdinalIgnoreCase
        )
        && !helperDirectory.StartsWith(
          installPrefix,
          StringComparison.OrdinalIgnoreCase
        );
    } catch {
      return false;
    }
  }

  private static UpdateSupervisorRequest ParseUpdateSupervisorRequest(
    string input,
    string supervisorPath
  ) {
    if (
      input == null
      || Encoding.UTF8.GetByteCount(input) > MAX_UPDATE_REQUEST_BYTES
      || !String.Equals(
        ExactFullPath(supervisorPath),
        supervisorPath,
        StringComparison.OrdinalIgnoreCase
      )
    ) return null;
    string[] lines = input.Split(new char[] { '\n' }, StringSplitOptions.None);
    if (
      lines.Length != 17
      || !String.Equals(
        lines[0],
        "INERTIA_UPDATE_SUPERVISOR_V1",
        StringComparison.Ordinal
      )
      || lines[16].Length != 0
    ) return null;
    string operationId = DecodeUpdateField(lines[1], "operationId");
    string handoffChecksum = DecodeUpdateField(lines[2], "handoffChecksum");
    string launchId = DecodeUpdateField(lines[3], "launchId");
    string parentProcessIdValue = DecodeUpdateField(lines[4], "parentProcessId");
    string installerPath = ExactFullPath(
      DecodeUpdateField(lines[5], "installerPath")
    );
    string installerDigest = DecodeUpdateField(lines[6], "installerDigest");
    string oldExecutablePath = ExactFullPath(
      DecodeUpdateField(lines[7], "oldExecutablePath")
    );
    string oldExecutableDigest = DecodeUpdateField(
      lines[8],
      "oldExecutableDigest"
    );
    string newExecutablePath = ExactFullPath(
      DecodeUpdateField(lines[9], "newExecutablePath")
    );
    string newExecutableDigest = DecodeUpdateField(
      lines[10],
      "newExecutableDigest"
    );
    string receiptPath = ExactFullPath(
      DecodeUpdateField(lines[11], "receiptPath")
    );
    string receiptTemporaryPath = ExactFullPath(
      DecodeUpdateField(lines[12], "receiptTemporaryPath")
    );
    string supervisorDigest = DecodeUpdateField(lines[13], "supervisorDigest");
    string handoffToken = DecodeUpdateField(lines[14], "handoffToken");
    string deadlineAtValue = DecodeUpdateField(lines[15], "deadlineAt");
    UInt32 parentProcessId;
    DateTimeOffset deadlineAt;
    if (
      !ValidOperationId(operationId)
      || !ValidDigest(handoffChecksum)
      || !ValidOperationId(launchId)
      || !UInt32.TryParse(
        parentProcessIdValue,
        NumberStyles.None,
        CultureInfo.InvariantCulture,
        out parentProcessId
      )
      || parentProcessId <= 1
      || parentProcessId > Int32.MaxValue
      || installerPath == null
      || !ValidDigest(installerDigest)
      || oldExecutablePath == null
      || !ValidDigest(oldExecutableDigest)
      || newExecutablePath == null
      || !String.Equals(
        newExecutablePath,
        oldExecutablePath,
        StringComparison.OrdinalIgnoreCase
      )
      || !ValidDigest(newExecutableDigest)
      || receiptPath == null
      || receiptTemporaryPath == null
      || !ValidDigest(supervisorDigest)
      || !ValidToken(handoffToken)
      || !DateTimeOffset.TryParse(
        deadlineAtValue,
        CultureInfo.InvariantCulture,
        DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal,
        out deadlineAt
      )
      || !String.Equals(
        deadlineAt.UtcDateTime.ToString(
          "yyyy-MM-dd'T'HH:mm:ss.fff'Z'",
          CultureInfo.InvariantCulture
        ),
        deadlineAtValue,
        StringComparison.Ordinal
      )
    ) return null;
    string hash = OperationHash(operationId);
    string receiptDirectory = Path.GetDirectoryName(receiptPath);
    string helperDirectory = Path.GetDirectoryName(supervisorPath);
    if (
      receiptDirectory == null
      || helperDirectory == null
      || !String.Equals(
        receiptDirectory,
        helperDirectory,
        StringComparison.OrdinalIgnoreCase
      )
      || !DirectDirectory(receiptDirectory)
      || !String.Equals(
        Path.GetFileName(supervisorPath),
        ".app-update-supervisor-" + hash + ".exe",
        StringComparison.Ordinal
      )
      || !String.Equals(
        Path.GetFileName(receiptPath),
        ".app-update-terminal-receipt-" + hash + ".json",
        StringComparison.Ordinal
      )
      || !String.Equals(
        receiptTemporaryPath,
        receiptPath.Substring(0, receiptPath.Length - 5) + ".publish.tmp",
        StringComparison.OrdinalIgnoreCase
      )
      || File.Exists(receiptPath)
      || File.Exists(receiptTemporaryPath)
      || !OutsideInstallTree(
        supervisorPath,
        oldExecutablePath
      )
    ) return null;
    return new UpdateSupervisorRequest {
      OperationId = operationId,
      HandoffChecksum = handoffChecksum,
      LaunchId = launchId,
      ParentProcessId = parentProcessId,
      InstallerPath = installerPath,
      InstallerDigest = installerDigest,
      OldExecutablePath = oldExecutablePath,
      OldExecutableDigest = oldExecutableDigest,
      NewExecutablePath = newExecutablePath,
      NewExecutableDigest = newExecutableDigest,
      ReceiptPath = receiptPath,
      ReceiptTemporaryPath = receiptTemporaryPath,
      SupervisorDigest = supervisorDigest,
      HandoffToken = handoffToken,
      DeadlineAtText = deadlineAtValue,
      DeadlineAt = deadlineAt,
    };
  }

  private static FileStream OpenUpdateArtifact(
    string path,
    out string digest
  ) {
    digest = null;
    FileStream stream = null;
    try {
      var metadata = new FileInfo(path);
      if (
        !metadata.Exists
        || (metadata.Attributes & FileAttributes.ReparsePoint) != 0
        || metadata.Length <= 0
        || metadata.Length > MAX_UPDATE_ARTIFACT_BYTES
      ) return null;
      stream = new FileStream(
        path,
        FileMode.Open,
        FileAccess.Read,
        FileShare.Read
      );
      if (stream.Length != metadata.Length) {
        stream.Dispose();
        return null;
      }
      using (var sha256 = SHA256.Create()) {
        digest = BytesToHex(sha256.ComputeHash(stream));
      }
      if (stream.Position != stream.Length) {
        stream.Dispose();
        return null;
      }
      var confirmed = new FileInfo(path);
      if (
        !confirmed.Exists
        || (confirmed.Attributes & FileAttributes.ReparsePoint) != 0
        || confirmed.Length != stream.Length
      ) {
        stream.Dispose();
        return null;
      }
      return stream;
    } catch {
      if (stream != null) stream.Dispose();
      digest = null;
      return null;
    }
  }

  private static string ProcessExecutablePath(IntPtr process) {
    var path = new StringBuilder(32768);
    UInt32 length = (UInt32)path.Capacity;
    return QueryFullProcessImageName(process, 0, path, ref length)
      ? ExactFullPath(path.ToString())
      : null;
  }

  private static bool LaunchInstaller(
    UpdateSupervisorRequest request,
    UpdateDeadline deadline,
    out bool started,
    out bool deadlineExceeded,
    out UInt32? exitCode,
    out int win32Error
  ) {
    started = false;
    deadlineExceeded = false;
    exitCode = null;
    win32Error = 0;
    var execute = new SHELLEXECUTEINFO();
    execute.cbSize = Marshal.SizeOf(typeof(SHELLEXECUTEINFO));
    execute.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC;
    execute.lpFile = request.InstallerPath;
    // This repository ships the complete default per-user NSIS target: there
    // is no web package or custom installDirectory argument to preserve.
    // --updated /S matches NsisUpdater's silent update flags, while omitting
    // --force-run ensures only this supervisor starts the rehashed result.
    // ShellExecuteEx honors any execution-level manifest embedded by NSIS and
    // gives us the exact waitable installer handle across UAC elevation.
    execute.lpParameters = "--updated /S";
    execute.lpDirectory = Path.GetDirectoryName(request.InstallerPath);
    execute.nShow = 0;
    if (!ShellExecuteEx(ref execute) || execute.hProcess == IntPtr.Zero) {
      win32Error = Marshal.GetLastWin32Error();
      return false;
    }
    started = true;
    try {
      UInt32 remaining = deadline.RemainingMilliseconds();
      UInt32 waitResult = remaining == 0
        ? WAIT_TIMEOUT
        : WaitForSingleObject(execute.hProcess, remaining);
      if (waitResult == WAIT_TIMEOUT) {
        // Once the exact installer starts, its result is ambiguous until that
        // same process handle signals. Do not kill it or pretend that it was
        // cleaned up: publish a durable quarantine and stop supervising at the
        // authority deadline. Startup then remains fail-closed across reboot
        // while the native installer is free to finish its own transaction.
        deadlineExceeded = true;
        return false;
      }
      if (waitResult != WAIT_OBJECT_0) {
        win32Error = Marshal.GetLastWin32Error();
        return false;
      }
      UInt32 result;
      if (!GetExitCodeProcess(execute.hProcess, out result)) {
        win32Error = Marshal.GetLastWin32Error();
        return false;
      }
      if (result == STILL_ACTIVE) return false;
      exitCode = result;
      return true;
    } finally {
      CloseHandle(execute.hProcess);
    }
  }

  private static string TerminalAuthenticationPayload(
    UpdateSupervisorRequest request,
    string outcome,
    UInt32? installerExitCode,
    string executableDigest,
    string parentCreationTimeBits,
    string completedAt
  ) {
    string exitCode = installerExitCode.HasValue
      ? installerExitCode.Value.ToString(CultureInfo.InvariantCulture)
      : "null";
    string executable = executableDigest == null
      ? "null"
      : "\"" + executableDigest + "\"";
    return "[1,\"" + request.OperationId
      + "\",\"" + request.HandoffChecksum
      + "\",\"" + outcome
      + "\"," + exitCode
      + ",\"" + request.InstallerDigest
      + "\",\"" + request.SupervisorDigest
      + "\"," + executable
      + ",\"" + parentCreationTimeBits
      + "\",\"" + completedAt + "\"]";
  }

  private static string OperationClaimAuthenticationPayload(
    UpdateSupervisorRequest request
  ) {
    return "[1,\"" + request.OperationId
      + "\",\"" + request.HandoffChecksum
      + "\",\"" + request.LaunchId
      + "\",\"" + request.SupervisorDigest
      + "\",\"" + request.DeadlineAtText + "\"]";
  }

  private static string OperationClaimAuthenticationTag(
    UpdateSupervisorRequest request
  ) {
    using (var hmac = new HMACSHA256(
      Encoding.UTF8.GetBytes(request.HandoffToken)
    )) {
      return BytesToHex(hmac.ComputeHash(Encoding.UTF8.GetBytes(
        "inertia.windows-update-operation-claim.v1\0"
          + OperationClaimAuthenticationPayload(request)
      )));
    }
  }

  private static FileStream CreateOwnedOperationClaimFile(string path) {
    IntPtr handle = CreateFile(
      path,
      GENERIC_READ | GENERIC_WRITE | DELETE_ACCESS,
      0,
      IntPtr.Zero,
      CREATE_NEW_FILE,
      FILE_ATTRIBUTE_NORMAL | FILE_FLAG_WRITE_THROUGH,
      IntPtr.Zero
    );
    var safeHandle = new SafeFileHandle(handle, true);
    if (safeHandle.IsInvalid) {
      safeHandle.Dispose();
      return null;
    }
    try {
      return new FileStream(
        safeHandle,
        FileAccess.ReadWrite,
        4096,
        false
      );
    } catch {
      safeHandle.Dispose();
      return null;
    }
  }

  private static bool RenameOwnedOperationClaim(
    FileStream claim,
    string receiptPath
  ) {
    byte[] name = Encoding.Unicode.GetBytes(receiptPath);
    int rootOffset = IntPtr.Size == 8 ? 8 : 4;
    int lengthOffset = rootOffset + IntPtr.Size;
    int nameOffset = lengthOffset + 4;
    int bufferLength = nameOffset + name.Length + 2;
    IntPtr information = Marshal.AllocHGlobal(bufferLength);
    try {
      for (int index = 0; index < nameOffset; index += 1) {
        Marshal.WriteByte(information, index, 0);
      }
      Marshal.WriteIntPtr(information, rootOffset, IntPtr.Zero);
      Marshal.WriteInt32(information, lengthOffset, name.Length);
      Marshal.Copy(name, 0, IntPtr.Add(information, nameOffset), name.Length);
      // FileNameLength excludes the terminator; the Win32 path conversion can
      // still consume FileName as a NUL-terminated string.
      Marshal.WriteInt16(information, nameOffset + name.Length, (Int16)0);
      return SetFileInformationByHandle(
        claim.SafeFileHandle.DangerousGetHandle(),
        FileRenameInfo,
        information,
        (UInt32)bufferLength
      );
    } finally {
      Marshal.FreeHGlobal(information);
    }
  }

  private static FileStream AcquireOperationClaim(
    UpdateSupervisorRequest request
  ) {
    FileStream claim = null;
    try {
      string json = "{\"schemaVersion\":1"
        + ",\"operationId\":\"" + request.OperationId + "\""
        + ",\"handoffChecksum\":\"" + request.HandoffChecksum + "\""
        + ",\"launchId\":\"" + request.LaunchId + "\""
        + ",\"supervisorDigest\":\"" + request.SupervisorDigest + "\""
        + ",\"deadlineAt\":\"" + request.DeadlineAtText + "\""
        + ",\"authenticationTag\":\""
        + OperationClaimAuthenticationTag(request) + "\"}";
      byte[] bytes = new UTF8Encoding(false).GetBytes(json);
      claim = CreateOwnedOperationClaimFile(request.ReceiptTemporaryPath);
      if (claim == null) return null;
      claim.Write(bytes, 0, bytes.Length);
      claim.Flush(true);
      return claim;
    } catch {
      if (claim != null) claim.Dispose();
      return null;
    }
  }

  private static string TerminalAuthenticationTag(
    UpdateSupervisorRequest request,
    string payload
  ) {
    using (var hmac = new HMACSHA256(
      Encoding.UTF8.GetBytes(request.HandoffToken)
    )) {
      return BytesToHex(hmac.ComputeHash(Encoding.UTF8.GetBytes(
        "inertia.windows-update-terminal.v1\0" + payload
      )));
    }
  }

  private static bool PublishTerminalReceipt(
    UpdateSupervisorRequest request,
    ref FileStream operationClaim,
    string outcome,
    UInt32? installerExitCode,
    string executableDigest,
    string parentCreationTimeBits,
    DateTimeOffset completedAtValue
  ) {
    string completedAt = completedAtValue.UtcDateTime.ToString(
      "yyyy-MM-dd'T'HH:mm:ss.fff'Z'",
      CultureInfo.InvariantCulture
    );
    string payload = TerminalAuthenticationPayload(
      request,
      outcome,
      installerExitCode,
      executableDigest,
      parentCreationTimeBits,
      completedAt
    );
    string authenticationTag = TerminalAuthenticationTag(request, payload);
    string exitCode = installerExitCode.HasValue
      ? installerExitCode.Value.ToString(CultureInfo.InvariantCulture)
      : "null";
    string executable = executableDigest == null
      ? "null"
      : "\"" + executableDigest + "\"";
    string json = "{\"schemaVersion\":1"
      + ",\"operationId\":\"" + request.OperationId + "\""
      + ",\"handoffChecksum\":\"" + request.HandoffChecksum + "\""
      + ",\"outcome\":\"" + outcome + "\""
      + ",\"installerExitCode\":" + exitCode
      + ",\"installerDigest\":\"" + request.InstallerDigest + "\""
      + ",\"supervisorDigest\":\"" + request.SupervisorDigest + "\""
      + ",\"executableDigest\":" + executable
      + ",\"parentCreationTimeBits\":\"" + parentCreationTimeBits + "\""
      + ",\"completedAt\":\"" + completedAt + "\""
      + ",\"authenticationTag\":\"" + authenticationTag + "\"}";
    byte[] bytes = new UTF8Encoding(false).GetBytes(json);
    try {
      if (operationClaim == null) return false;
      operationClaim.Position = 0;
      operationClaim.SetLength(0);
      operationClaim.Write(bytes, 0, bytes.Length);
      operationClaim.Flush(true);
      if (!RenameOwnedOperationClaim(operationClaim, request.ReceiptPath)) {
        return false;
      }
      operationClaim.Flush(true);
      operationClaim.Dispose();
      operationClaim = null;
      return File.Exists(request.ReceiptPath)
        && !File.Exists(request.ReceiptTemporaryPath);
    } catch {
      return false;
    }
  }

  private static void LaunchVerifiedApplication(
    string executablePath,
    string expectedDigest,
    UpdateDeadline deadline
  ) {
    string digest;
    using (FileStream executable = OpenUpdateArtifact(
      executablePath,
      out digest
    )) {
      if (
        executable == null
        || !String.Equals(digest, expectedDigest, StringComparison.Ordinal)
        || deadline.Expired
      ) return;
      var start = new ProcessStartInfo();
      start.FileName = executablePath;
      start.WorkingDirectory = Path.GetDirectoryName(executablePath);
      start.UseShellExecute = false;
      Process launched = Process.Start(start);
      if (launched != null) launched.Dispose();
    }
  }

  private sealed class UpdateSupervisorProcess : IDisposable {
    private IntPtr processHandle;
    private AnonymousPipeServerStream inputPipe, outputPipe, errorPipe;
    public StreamWriter StandardInput;
    public StreamReader StandardOutput;

    public static UpdateSupervisorProcess Start(
      string executable, string arguments, out string stage
    ) {
      stage = "update-launch-pipes";
      var child = new UpdateSupervisorProcess();
      IntPtr attributes = IntPtr.Zero;
      IntPtr handleList = IntPtr.Zero;
      bool attributesInitialized = false;
      bool started = false;
      var information = new PROCESS_INFORMATION();
      try {
        child.inputPipe = new AnonymousPipeServerStream(
          PipeDirection.Out, HandleInheritability.Inheritable
        );
        child.outputPipe = new AnonymousPipeServerStream(
          PipeDirection.In, HandleInheritability.Inheritable
        );
        child.errorPipe = new AnonymousPipeServerStream(
          PipeDirection.In, HandleInheritability.Inheritable
        );
        child.StandardInput = new StreamWriter(
          child.inputPipe, new UTF8Encoding(false)
        );
        child.StandardInput.AutoFlush = true;
        child.StandardOutput = new StreamReader(child.outputPipe, Encoding.UTF8);

        // Redirection alone in .NET Framework still copies other inheritable
        // handles, including cached copies of the broker's console pipes.
        // This list transfers only the supervisor's three private pipe ends.
        IntPtr[] handles = {
          child.inputPipe.ClientSafePipeHandle.DangerousGetHandle(),
          child.outputPipe.ClientSafePipeHandle.DangerousGetHandle(),
          child.errorPipe.ClientSafePipeHandle.DangerousGetHandle()
        };
        stage = "update-launch-attributes";
        UIntPtr attributeSize = UIntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attributeSize);
        if (attributeSize.ToUInt64() == 0 || attributeSize.ToUInt64() > 65536) {
          throw new InvalidOperationException("Invalid process attribute size.");
        }
        attributes = Marshal.AllocHGlobal((Int32)attributeSize.ToUInt64());
        if (!InitializeProcThreadAttributeList(attributes, 1, 0, ref attributeSize)) {
          throw new System.ComponentModel.Win32Exception();
        }
        attributesInitialized = true;
        handleList = Marshal.AllocHGlobal(handles.Length * IntPtr.Size);
        for (int index = 0; index < handles.Length; index += 1) {
          Marshal.WriteIntPtr(handleList, index * IntPtr.Size, handles[index]);
        }
        if (!UpdateProcThreadAttribute(
          attributes, 0, new UIntPtr(PROC_THREAD_ATTRIBUTE_HANDLE_LIST),
          handleList, new UIntPtr((UInt32)(handles.Length * IntPtr.Size)),
          IntPtr.Zero, IntPtr.Zero
        )) {
          throw new System.ComponentModel.Win32Exception();
        }
        var startup = new STARTUPINFOEX();
        startup.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput = handles[0];
        startup.StartupInfo.hStdOutput = handles[1];
        startup.StartupInfo.hStdError = handles[2];
        startup.lpAttributeList = attributes;
        var commandLine = new StringBuilder("\"" + executable + "\" " + arguments);
        stage = "update-launch-create";
        if (!CreateProcessW(
          executable, commandLine, IntPtr.Zero, IntPtr.Zero, true,
          EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW,
          IntPtr.Zero, null, ref startup, out information
        )) {
          throw new System.ComponentModel.Win32Exception();
        }
        // Retain the exact creation handle rather than reopening a reusable PID.
        child.processHandle = information.hProcess;
        started = true;
        return child;
      } finally {
        if (information.hThread != IntPtr.Zero) CloseHandle(information.hThread);
        if (attributesInitialized) DeleteProcThreadAttributeList(attributes);
        if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
        if (handleList != IntPtr.Zero) Marshal.FreeHGlobal(handleList);
        if (child.inputPipe != null) child.inputPipe.DisposeLocalCopyOfClientHandle();
        if (child.outputPipe != null) child.outputPipe.DisposeLocalCopyOfClientHandle();
        if (child.errorPipe != null) child.errorPipe.DisposeLocalCopyOfClientHandle();
        if (!started) child.Dispose();
      }
    }

    public bool HasExited {
      get { return WaitForExit(0); }
    }

    public bool WaitForExit(int timeoutMilliseconds) {
      UInt32 result = WaitForSingleObject(
        processHandle, (UInt32)Math.Max(0, timeoutMilliseconds)
      );
      if (result == WAIT_OBJECT_0) return true;
      if (result == WAIT_TIMEOUT) return false;
      throw new System.ComponentModel.Win32Exception();
    }

    public void Kill() {
      if (!TerminateProcess(processHandle, 137)) {
        throw new System.ComponentModel.Win32Exception();
      }
    }

    private static void DisposeStream(IDisposable stream) {
      try { if (stream != null) stream.Dispose(); } catch (IOException) { }
    }

    public void Dispose() {
      DisposeStream(StandardInput);
      DisposeStream(StandardOutput);
      DisposeStream(inputPipe);
      DisposeStream(outputPipe);
      DisposeStream(errorPipe);
      if (processHandle != IntPtr.Zero) {
        CloseHandle(processHandle);
        processHandle = IntPtr.Zero;
      }
    }
  }

  public static int LaunchUpdateSupervisor(
    string supervisorPath,
    string expectedSupervisorDigest,
    string requestText,
    int timeoutMilliseconds,
    out string output,
    out string diagnostic
  ) {
    output = "";
    diagnostic = "";
    UpdateSupervisorProcess child = null;
    FileStream supervisor = null;
    string launchStage = "update-launch";
    try {
      if (
        !String.Equals(
          ExactFullPath(supervisorPath),
          supervisorPath,
          StringComparison.OrdinalIgnoreCase
        )
        || !ValidDigest(expectedSupervisorDigest)
        || requestText == null
        || Encoding.UTF8.GetByteCount(requestText) < 1
        || Encoding.UTF8.GetByteCount(requestText) > MAX_UPDATE_REQUEST_BYTES
        || timeoutMilliseconds < 1
        || timeoutMilliseconds > 15000
      ) {
        diagnostic = ErrorLine("update-launch-request", 0);
        return 46;
      }
      string supervisorDigest;
      supervisor = OpenUpdateArtifact(supervisorPath, out supervisorDigest);
      if (
        supervisor == null
        || supervisor.Length > MAX_EXECUTABLE_BYTES
        || !String.Equals(
          supervisorDigest,
          expectedSupervisorDigest,
          StringComparison.Ordinal
        )
      ) {
        diagnostic = ErrorLine("update-launch-integrity", 0);
        return 46;
      }
      supervisor.Position = 0;
      byte[] supervisorBytes = new byte[(Int32)supervisor.Length];
      int offset = 0;
      while (offset < supervisorBytes.Length) {
        int read = supervisor.Read(
          supervisorBytes,
          offset,
          supervisorBytes.Length - offset
        );
        if (read <= 0) {
          diagnostic = ErrorLine("update-launch-read", 0);
          return 46;
        }
        offset += read;
      }
      if (supervisor.ReadByte() != -1) {
        diagnostic = ErrorLine("update-launch-read", 0);
        return 46;
      }

      string loaderScript = @"$ErrorActionPreference = 'Stop'
$stream = $null
try {
  $assemblyLine = [Console]::In.ReadLine()
  $digest = [Console]::In.ReadLine()
  $pathLine = [Console]::In.ReadLine()
  $launcherPid = [Console]::In.ReadLine()
  $requestLine = [Console]::In.ReadLine()
  if ($null -eq $assemblyLine -or $assemblyLine.Length -lt 1 -or $assemblyLine.Length -gt 1400000 -or
    $digest -notmatch '^[0-9a-f]{64}$' -or
    $null -eq $pathLine -or $pathLine.Length -lt 1 -or $pathLine.Length -gt 11000 -or
    $launcherPid -notmatch '^[1-9][0-9]{0,9}$' -or
    $null -eq $requestLine -or $requestLine.Length -lt 1 -or $requestLine.Length -gt 88000) {
    throw 'input'
  }
  $assemblyBytes = [Convert]::FromBase64String($assemblyLine)
  $pathBytes = [Convert]::FromBase64String($pathLine)
  $requestBytes = [Convert]::FromBase64String($requestLine)
  if ([Convert]::ToBase64String($assemblyBytes) -cne $assemblyLine -or
    [Convert]::ToBase64String($pathBytes) -cne $pathLine -or
    [Convert]::ToBase64String($requestBytes) -cne $requestLine -or
    $assemblyBytes.Length -lt 1 -or $assemblyBytes.Length -gt 1048576 -or
    $requestBytes.Length -lt 1 -or $requestBytes.Length -gt 65536) {
    throw 'encoding'
  }
  $utf8 = [Text.UTF8Encoding]::new($false, $true)
  $supervisorPath = $utf8.GetString($pathBytes)
  $request = $utf8.GetString($requestBytes)
  $stream = [IO.File]::Open(
    $supervisorPath,
    [IO.FileMode]::Open,
    [IO.FileAccess]::Read,
    [IO.FileShare]::Read
  )
  if ($stream.Length -ne $assemblyBytes.Length) { throw 'path-size' }
  $sha256 = [Security.Cryptography.SHA256]::Create()
  try {
    $pathDigest = [BitConverter]::ToString(
      $sha256.ComputeHash($stream)
    ).Replace('-', '').ToLowerInvariant()
    $byteDigest = [BitConverter]::ToString(
      $sha256.ComputeHash($assemblyBytes)
    ).Replace('-', '').ToLowerInvariant()
  } finally {
    $sha256.Dispose()
  }
  if ($pathDigest -cne $digest -or $byteDigest -cne $digest) {
    throw 'integrity'
  }
  $loaded = [Reflection.Assembly]::Load($assemblyBytes)
  $type = $loaded.GetType('InertiaRuntimeJob', $true, $false)
  $method = $type.GetMethod('UpdateSupervisorFromBroker')
  if ($null -eq $method) { throw 'contract' }
  $arguments = [Object[]]@($digest, $launcherPid, $request, $supervisorPath)
  exit ([Int32]$method.Invoke($null, $arguments))
} catch {
  [Console]::Error.WriteLine('INERTIA_JOB_ERROR stage=update-loader')
  exit 46
} finally {
  if ($null -ne $stream) { $stream.Dispose() }
}";
      byte[] loaderBytes = new UTF8Encoding(false, true).GetBytes(loaderScript);
      if (loaderBytes.Length == 0 || loaderBytes.Length > 16384) {
        diagnostic = ErrorLine("update-launch-loader-size", 0);
        return 46;
      }
      // The broker uses the same two-stage transport to keep the trusted
      // PowerShell command line small on Windows ARM64.
      string bootstrapScript = @"$ErrorActionPreference = 'Stop'
try {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line -or $line.Length -lt 1 -or $line.Length -gt 21848) { throw 'size' }
  $bytes = [Convert]::FromBase64String($line)
  if ($bytes.Length -lt 1 -or $bytes.Length -gt 16384 -or
    [Convert]::ToBase64String($bytes) -cne $line) { throw 'encoding' }
  $utf8 = [Text.UTF8Encoding]::new($false, $true)
  & ([ScriptBlock]::Create($utf8.GetString($bytes)))
} catch {
  [Console]::Error.WriteLine('INERTIA_JOB_ERROR stage=update-bootstrap')
  exit 46
}";
      string encodedBootstrap = Convert.ToBase64String(
        Encoding.Unicode.GetBytes(bootstrapScript)
      );
      string powershellPath = TrustedPowerShellPath();
      if (powershellPath == null) {
        diagnostic = ErrorLine("update-launch-powershell", 0);
        return 46;
      }
      child = UpdateSupervisorProcess.Start(
        powershellPath,
        "-NoLogo -NoProfile -NonInteractive "
          + "-ExecutionPolicy Bypass -EncodedCommand " + encodedBootstrap,
        out launchStage
      );
      launchStage = "update-launch-input";
      child.StandardInput.WriteLine(Convert.ToBase64String(loaderBytes));
      child.StandardInput.WriteLine(Convert.ToBase64String(supervisorBytes));
      child.StandardInput.WriteLine(expectedSupervisorDigest);
      child.StandardInput.WriteLine(Convert.ToBase64String(
        Encoding.UTF8.GetBytes(supervisorPath)
      ));
      using (Process launcher = Process.GetCurrentProcess()) {
        child.StandardInput.WriteLine(
          launcher.Id.ToString(CultureInfo.InvariantCulture)
        );
      }
      child.StandardInput.WriteLine(Convert.ToBase64String(
        Encoding.UTF8.GetBytes(requestText)
      ));
      child.StandardInput.Close();

      launchStage = "update-launch-ready";
      string readyLine = null;
      Exception readFailure = null;
      using (var ready = new ManualResetEvent(false)) {
        var reader = new Thread(delegate() {
          try {
            readyLine = child.StandardOutput.ReadLine();
          } catch (Exception error) {
            readFailure = error;
          } finally {
            // A timed-out admission can dispose the waiter before EOF arrives.
            try { ready.Set(); } catch (ObjectDisposedException) { }
          }
        });
        reader.IsBackground = true;
        reader.Start();
        var admission = Stopwatch.StartNew();
        while (
          !ready.WaitOne(10)
          && !child.HasExited
          && admission.ElapsedMilliseconds < timeoutMilliseconds
        ) { }
      }
      if (
        readFailure == null
        && String.Equals(readyLine, "READY", StringComparison.Ordinal)
        && readyLine.Length <= MAX_UPDATE_READY_BYTES
      ) {
        // READY is the authority-transfer boundary. A supervisor may publish
        // its terminal receipt and exit before this launcher gets scheduled
        // again; requiring it to remain alive would misclassify that admitted
        // operation as a pre-admission failure.
        output = "READY";
        return 0;
      }
      diagnostic = ErrorLine("update-launch-ready", 0);
      if (!child.HasExited) {
        try { child.Kill(); } catch { }
      }
      if (!child.WaitForExit(2000)) {
        diagnostic = ErrorLine("update-helper-exit-unconfirmed", 0);
        return UPDATE_LAUNCH_CLEANUP_UNCONFIRMED;
      }
      return 46;
    } catch (Exception error) {
      var nativeError = error as System.ComponentModel.Win32Exception;
      diagnostic = ErrorLine(
        launchStage,
        nativeError != null ? nativeError.NativeErrorCode : Marshal.GetLastWin32Error()
      );
      if (child != null && !child.HasExited) {
        try { child.Kill(); } catch { }
        try {
          if (!child.WaitForExit(2000)) {
            diagnostic = ErrorLine("update-helper-exit-unconfirmed", 0);
            return UPDATE_LAUNCH_CLEANUP_UNCONFIRMED;
          }
        } catch {
          diagnostic = ErrorLine("update-helper-exit-unconfirmed", 0);
          return UPDATE_LAUNCH_CLEANUP_UNCONFIRMED;
        }
      }
      return 46;
    } finally {
      if (supervisor != null) supervisor.Dispose();
      if (child != null) child.Dispose();
    }
  }

  private static string TrustedPowerShellPath() {
    try {
      string windows = Environment.GetFolderPath(
        Environment.SpecialFolder.Windows
      );
      return ExactFullPath(Path.Combine(
        windows,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe"
      ));
    } catch {
      return null;
    }
  }

  public static int UpdateSupervisorFromBroker(
    string expectedSupervisorDigest,
    string launcherProcessIdValue,
    string requestText,
    string supervisorPath
  ) {
    UpdateSupervisorRequest request = ParseUpdateSupervisorRequest(
      requestText,
      supervisorPath
    );
    UpdateDeadline deadline = request == null
      ? null
      : UpdateDeadline.Start(request.DeadlineAt);
    UInt32 launcherProcessId;
    if (
      request == null
      || deadline == null
      || !UInt32.TryParse(
        launcherProcessIdValue,
        NumberStyles.None,
        CultureInfo.InvariantCulture,
        out launcherProcessId
      )
      || launcherProcessId <= 1
      || launcherProcessId > Int32.MaxValue
      || launcherProcessId == request.ParentProcessId
      || !String.Equals(
        request.SupervisorDigest,
        expectedSupervisorDigest,
        StringComparison.Ordinal
      )
    ) return Failure("update-request", 31, 0);
    Process parent = null;
    Process launcher = null;
    FileStream installer = null;
    FileStream oldExecutable = null;
    FileStream operationClaim = null;
    try {
      try {
        double supervisorCreationTimeMs;
        using (Process supervisor = Process.GetCurrentProcess()) {
          UInt64 supervisorCreationBits;
          int supervisorIdentityError = 0;
          if (
            !ExpectedParent(
              (UInt32)supervisor.Id,
              launcherProcessId
            )
            || !ProcessIdentity(
              supervisor.Handle,
              out supervisorCreationBits,
              out supervisorCreationTimeMs,
              out supervisorIdentityError
            )
          ) return Failure("update-parent", 32, supervisorIdentityError);
        }
        launcher = Process.GetProcessById((Int32)launcherProcessId);
        UInt64 launcherCreationBits;
        double launcherCreationTimeMs;
        int launcherIdentityError;
        if (!ProcessIdentity(
          launcher.Handle,
          out launcherCreationBits,
          out launcherCreationTimeMs,
          out launcherIdentityError
        ) || launcherCreationTimeMs > supervisorCreationTimeMs) {
          return Failure("update-launcher", 32, launcherIdentityError);
        }
        string launcherPath = ProcessExecutablePath(launcher.Handle);
        if (!String.Equals(
          launcherPath,
          TrustedPowerShellPath(),
          StringComparison.OrdinalIgnoreCase
        )) return Failure("update-launcher", 32, 0);
        launcher.Dispose();
        launcher = null;
        parent = Process.GetProcessById((Int32)request.ParentProcessId);
        UInt64 parentCreationBits;
        double parentCreationTimeMs;
        int identityError;
        if (!ProcessIdentity(
          parent.Handle,
          out parentCreationBits,
          out parentCreationTimeMs,
          out identityError
        ) || parentCreationTimeMs > supervisorCreationTimeMs) {
          return Failure("update-parent", 32, identityError);
        }
        string parentPath = ProcessExecutablePath(parent.Handle);
        if (!String.Equals(
          parentPath,
          request.OldExecutablePath,
          StringComparison.OrdinalIgnoreCase
        )) return Failure("update-parent", 32, 0);
        string installerDigest;
        installer = OpenUpdateArtifact(
          request.InstallerPath,
          out installerDigest
        );
        string oldDigest;
        oldExecutable = OpenUpdateArtifact(
          request.OldExecutablePath,
          out oldDigest
        );
        if (
          installer == null
          || oldExecutable == null
          || !String.Equals(
            installerDigest,
            request.InstallerDigest,
            StringComparison.Ordinal
          )
          || !String.Equals(
            oldDigest,
            request.OldExecutableDigest,
            StringComparison.Ordinal
          )
        ) return Failure("update-artifact", 33, 0);

        operationClaim = AcquireOperationClaim(request);
        if (operationClaim == null) {
          return Failure("update-operation-claim", 37, 0);
        }
        WriteProtocolLine(Console.OpenStandardOutput(), "READY");
        UInt32 remaining = deadline.RemainingMilliseconds();
        if (remaining == 0 || WaitForSingleObject(parent.Handle, remaining) != 0) {
          return Failure("update-parent-wait", 34, Marshal.GetLastWin32Error());
        }
        parent.Dispose();
        parent = null;
        oldExecutable.Dispose();
        oldExecutable = null;

        UInt32? installerExitCode;
        bool installerStarted;
        bool installerDeadlineExceeded;
        int installError;
        bool installerCompleted = LaunchInstaller(
          request,
          deadline,
          out installerStarted,
          out installerDeadlineExceeded,
          out installerExitCode,
          out installError
        );
        installer.Dispose();
        installer = null;

        // Reading or launching through the installation namespace while an
        // unconfirmed NSIS process may still mutate it would manufacture false
        // terminal evidence. The authenticated nulls instead mean that exact
        // installer completion was not observed.
        bool installerCompletionUnconfirmed =
          installerStarted && !installerCompleted;
        string executableDigest = null;
        if (!installerCompletionUnconfirmed) {
          FileStream resultingExecutable = OpenUpdateArtifact(
            request.NewExecutablePath,
            out executableDigest
          );
          if (resultingExecutable != null) resultingExecutable.Dispose();
        }
        string outcome;
        string launchDigest = null;
        if (installerDeadlineExceeded || installerCompletionUnconfirmed) {
          outcome = "quarantined";
        } else if (
          installerCompleted
          && installerExitCode.HasValue
          && installerExitCode.Value == 0
          && String.Equals(
            executableDigest,
            request.NewExecutableDigest,
            StringComparison.Ordinal
          )
        ) {
          outcome = "success";
          launchDigest = request.NewExecutableDigest;
        } else if (
          !installerStarted
          && String.Equals(
            executableDigest,
            request.OldExecutableDigest,
            StringComparison.Ordinal
          )
        ) {
          outcome = "clean-failure";
          launchDigest = request.OldExecutableDigest;
        } else {
          outcome = "quarantined";
        }
        DateTimeOffset terminalAt = deadline.CurrentTime;
        if (deadline.Expired) {
          outcome = "quarantined";
          launchDigest = null;
        }
        string parentCreationTimeBits = parentCreationBits.ToString(
          CultureInfo.InvariantCulture
        );
        if (!PublishTerminalReceipt(
          request,
          ref operationClaim,
          outcome,
          installerCompleted ? installerExitCode : null,
          executableDigest,
          parentCreationTimeBits,
          terminalAt
        )) return Failure("update-receipt", 35, installError);
        if (
          launchDigest != null
          && !deadline.Expired
        ) {
          LaunchVerifiedApplication(
            request.NewExecutablePath,
            launchDigest,
            deadline
          );
        }
        return 0;
      } catch {
        return Failure("update-supervisor", 36, Marshal.GetLastWin32Error());
      }
    } finally {
      if (oldExecutable != null) oldExecutable.Dispose();
      if (installer != null) installer.Dispose();
      if (operationClaim != null) operationClaim.Dispose();
      if (launcher != null) launcher.Dispose();
      if (parent != null) parent.Dispose();
    }
  }

  public static int Main(string[] arguments) {
    if (
      arguments == null
      || arguments.Length < 2
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
