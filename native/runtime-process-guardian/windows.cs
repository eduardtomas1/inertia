using System;
using System.IO;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;

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

  private const UInt32 JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
  private const UInt32 JOB_OBJECT_QUERY = 0x0004;
  private const UInt32 JOB_OBJECT_TERMINATE = 0x0008;
  private const UInt32 INFINITE = 0xffffffff;
  private const UInt64 WINDOWS_TO_UNIX_EPOCH_TICKS = 116444736000000000;
  private const Int32 ERROR_FILE_NOT_FOUND = 2;
  private const int JobObjectBasicAccountingInformation = 1;
  private const int JobObjectExtendedLimitInformation = 9;

  private static void WriteProtocolLine(Stream stream, string value) {
    byte[] bytes = Encoding.UTF8.GetBytes(value + "\n");
    stream.Write(bytes, 0, bytes.Length);
    stream.Flush();
  }

  private static int Failure(string stage, int exitCode, int win32Error) {
    WriteProtocolLine(
      Console.OpenStandardError(),
      "INERTIA_JOB_ERROR stage=" + stage + " win32=" + win32Error
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
      // PowerShell 5.1's redirected Console.Out encoding is host-dependent.
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
      if (!TerminateJobObject(job, 137)) {
        return Failure("terminate-job", 15, Marshal.GetLastWin32Error());
      }
      for (int index = 0; index < 200 && ActiveProcesses(job) != 0; index += 1) {
        System.Threading.Thread.Sleep(10);
      }
      return ActiveProcesses(job) == 0 ? 0 : 16;
    } finally {
      CloseHandle(job);
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
}
