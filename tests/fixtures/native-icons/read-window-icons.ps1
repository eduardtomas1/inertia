param([Parameter(Mandatory=$true)][string]$WindowHandle, [Parameter(Mandatory=$true)][string]$IconPath)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
public static class InertiaWindowIcons {
  [StructLayout(LayoutKind.Sequential)] struct ICONINFO { public bool icon; public uint x, y; public IntPtr mask, color; }
  [StructLayout(LayoutKind.Sequential)] struct BITMAP { public int type, width, height, stride; public ushort planes, bits; public IntPtr pixels; }
  [StructLayout(LayoutKind.Sequential)] struct HEADER { public uint size; public int width, height; public ushort planes, bits; public uint compression, imageSize; public int x, y; public uint used, important; }
  [DllImport("user32.dll", SetLastError=true)] static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint msg, UIntPtr w, IntPtr l, uint flags, uint timeout, out UIntPtr result);
  [DllImport("user32.dll", SetLastError=true)] static extern bool GetIconInfo(IntPtr icon, out ICONINFO info);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr LoadImage(IntPtr instance, string path, uint type, int width, int height, uint flags);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] static extern bool DestroyIcon(IntPtr icon);
  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr obj);
  [DllImport("gdi32.dll")] static extern int GetObject(IntPtr obj, int size, out BITMAP bitmap);
  [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
  [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
  [DllImport("gdi32.dll")] static extern int GetDIBits(IntPtr dc, IntPtr bitmap, uint start, uint count, byte[] bytes, ref HEADER info, uint usage);
  public static string Read(IntPtr icon) {
    ICONINFO info;
    if (icon == IntPtr.Zero || !GetIconInfo(icon, out info)) throw new Exception("The window has no native application icon.");
    IntPtr dc = IntPtr.Zero;
    try {
      BITMAP bitmap;
      if (info.color == IntPtr.Zero || GetObject(info.color, Marshal.SizeOf(typeof(BITMAP)), out bitmap) == 0) throw new Exception("No color icon bitmap.");
      if (bitmap.width <= 0 || bitmap.height <= 0 || bitmap.width > 1024 || bitmap.height > 1024) throw new Exception("Invalid native icon dimensions.");
      HEADER header = new HEADER { size = (uint)Marshal.SizeOf(typeof(HEADER)), width = bitmap.width, height = -bitmap.height, planes = 1, bits = 32 };
      byte[] bytes = new byte[bitmap.width * bitmap.height * 4];
      dc = CreateCompatibleDC(IntPtr.Zero);
      if (GetDIBits(dc, info.color, 0, (uint)bitmap.height, bytes, ref header, 0) != bitmap.height) throw new Exception("Cannot read native icon pixels.");
      string digest;
      using (SHA256 sha = SHA256.Create()) digest = BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant();
      return "{\"width\":" + bitmap.width + ",\"height\":" + bitmap.height + ",\"sha256\":\"" + digest + "\"}";
    } finally {
      if (dc != IntPtr.Zero) DeleteDC(dc);
      if (info.mask != IntPtr.Zero) DeleteObject(info.mask);
      if (info.color != IntPtr.Zero) DeleteObject(info.color);
    }
  }
  public static string Inspect(ulong window, string path) {
    string[] results = new string[2];
    for (int kind = 0; kind < 2; ++kind) {
      UIntPtr icon;
      if (SendMessageTimeout(new IntPtr(unchecked((long)window)), 0x007F, new UIntPtr((uint)kind), IntPtr.Zero, 2, 2000, out icon) == IntPtr.Zero) throw new Exception("Native icon query timed out.");
      int size = GetSystemMetrics(kind == 0 ? 49 : 11);
      IntPtr expected = LoadImage(IntPtr.Zero, path, 1, size, size, 0x0010);
      try { results[kind] = "{\"requestedSize\":" + size + ",\"actual\":" + Read(new IntPtr(unchecked((long)icon.ToUInt64()))) + ",\"expected\":" + Read(expected) + "}"; }
      finally { if (expected != IntPtr.Zero) DestroyIcon(expected); }
    }
    return "[" + String.Join(",", results) + "]";
  }
}
'@
[InertiaWindowIcons]::Inspect([Convert]::ToUInt64($WindowHandle, 16), $IconPath)
