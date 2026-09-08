// Diagnostic only: bounded metadata, never process arguments, environments or file contents.
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

public static class CleanupSnapshot {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct PROCESSENTRY32 {
    public uint dwSize, cntUsage, th32ProcessID;
    public UIntPtr th32DefaultHeapID;
    public uint th32ModuleID, cntThreads, th32ParentProcessID;
    public int pcPriClassBase;
    public uint dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
  }
  [StructLayout(LayoutKind.Sequential)] private struct FILETIME { public uint Low, High; }
  [StructLayout(LayoutKind.Sequential)] private struct IO_STATUS_BLOCK { public IntPtr Status; public UIntPtr Information; }
  [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool Process32First(IntPtr snapshot, ref PROCESSENTRY32 entry);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool Process32Next(IntPtr snapshot, ref PROCESSENTRY32 entry);
  [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetProcessTimes(IntPtr process, out FILETIME creation, out FILETIME exit, out FILETIME kernel, out FILETIME user);
  [DllImport("kernel32.dll", SetLastError = true)] private static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr CreateFileW(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("ntdll.dll")] private static extern int NtQueryInformationFile(IntPtr file, out IO_STATUS_BLOCK status, IntPtr info, uint length, int infoClass);
  private static readonly IntPtr Invalid = new IntPtr(-1);
  private static string Role(string name) {
    switch ((name ?? "").ToLowerInvariant()) {
      case "node.exe": return "node";
      case "cmd.exe": return "cmd";
      case "powershell.exe": return "powershell";
      case "pwsh.exe": return "pwsh";
      case "conhost.exe": return "conhost";
      case "openconsole.exe": return "openconsole";
      case "runtime-process-guardian.exe": return "guardian";
      case "git.exe": return "git";
      case "taskkill.exe": return "taskkill";
      case "msmpeng.exe": return "defender";
      default: return "other";
    }
  }
  private static string Creation(uint pid) {
    var handle = OpenProcess(0x1000, false, pid);
    if (handle == IntPtr.Zero) return null;
    try {
      FILETIME creation, exit, kernel, user;
      return GetProcessTimes(handle, out creation, out exit, out kernel, out user)
        ? (((ulong)creation.High << 32) | creation.Low).ToString() : null;
    } finally { CloseHandle(handle); }
  }
  // This documented-in-kernel file information class is only a diagnostic hint:
  // it need not enumerate current-directory references or every source of EBUSY.
  private static object DirectoryOwners(string path, HashSet<uint> selected) {
    var pids = new List<uint>();
    var handle = CreateFileW(path, 0x80, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
    if (handle == Invalid) return new { opened = false, error = Marshal.GetLastWin32Error(), status = 0, pids = pids, capped = false };
    var buffer = Marshal.AllocHGlobal(65536);
    try {
      IO_STATUS_BLOCK io;
      int status = NtQueryInformationFile(handle, out io, buffer, 65536, 47);
      int count = status == 0 ? Marshal.ReadInt32(buffer) : 0;
      for (int i = 0; i < Math.Min(Math.Max(count, 0), 128); i++) {
        long value = Marshal.ReadIntPtr(buffer, IntPtr.Size + i * IntPtr.Size).ToInt64();
        if (value <= 0 || value > uint.MaxValue) continue;
        pids.Add((uint)value); selected.Add((uint)value);
      }
      return new { opened = true, error = 0, status = status, pids = pids, capped = count > 128 };
    } finally { Marshal.FreeHGlobal(buffer); CloseHandle(handle); }
  }
  public static int Main(string[] args) {
    try {
      uint worker;
      if (args.Length != 3 || !uint.TryParse(args[0], out worker) || worker == 0) return 2;
      string root = Path.GetFullPath(args[1]);
      string runnerTemp = Path.GetFullPath(Environment.GetEnvironmentVariable("RUNNER_TEMP") ?? "").TrimEnd('\\');
      if (!String.Equals(Path.GetDirectoryName(root), runnerTemp, StringComparison.OrdinalIgnoreCase)
        || !Regex.IsMatch(Path.GetFileName(root), "^inertia-runtime-[A-Za-z0-9]+$")) return 2;
      var selected = new HashSet<uint>(); selected.Add(worker);
      string[] pidArgs = args[2].Split(',');
      if (pidArgs.Length > 64) return 2;
      foreach (string value in pidArgs) { uint pid; if (uint.TryParse(value, out pid) && pid > 0) selected.Add(pid); }
      object rootOwners = DirectoryOwners(root, selected);
      object workspaceOwners = DirectoryOwners(Path.Combine(root, "workspace"), selected);
      var entries = new List<PROCESSENTRY32>();
      var snapshot = CreateToolhelp32Snapshot(2, 0);
      if (snapshot == Invalid) return 3;
      try {
        var entry = new PROCESSENTRY32(); entry.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
        if (Process32First(snapshot, ref entry)) do { entries.Add(entry); } while (entries.Count < 4096 && Process32Next(snapshot, ref entry));
      } finally { CloseHandle(snapshot); }
      for (int depth = 0; depth < 16; depth++) {
        bool changed = false;
        foreach (var entry in entries) if (selected.Contains(entry.th32ParentProcessID)) changed |= selected.Add(entry.th32ProcessID);
        if (!changed) break;
      }
      var processes = new List<object>();
      foreach (var entry in entries) {
        if (!selected.Contains(entry.th32ProcessID) || processes.Count >= 256) continue;
        processes.Add(new { pid = entry.th32ProcessID, ppid = entry.th32ParentProcessID,
          creationFileTime = Creation(entry.th32ProcessID), role = Role(entry.szExeFile) });
      }
      Console.WriteLine(new JavaScriptSerializer().Serialize(new { schema = 1, workerPid = worker,
        processTableCapped = entries.Count >= 4096, selectedCapped = selected.Count > 256,
        processes = processes, rootHandleHint = rootOwners, workspaceHandleHint = workspaceOwners }));
      return 0;
    } catch { Console.WriteLine("{\"schema\":1,\"failure\":\"snapshot-failed\"}"); return 1; }
  }
}
