# windows.ps1 - persistent Windows window capture backend for dsh-live-preview.
#
# Started by host/windows.js as:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File windows.ps1
#
# Protocol: one command per stdin line, exactly one response line per command.
#   [#<id> ]LIST                                 -> {"id":<id>,"ok":true,"windows":[...]}
#   [#<id> ]INFO <hwnd>                          -> {"id":<id>,"ok":true,"window":{...}}
#   [#<id> ]CAPTURE <hwnd> <maxWidth> <quality>  -> FRAME <id> <base64-of-jpeg-bytes>
#   [#<id> ]ACTIVATE <hwnd>                      -> {"id":<id>,"ok":true,"hwnd":<hwnd>}
#   [#<id> ]EXIT                                 -> {"id":<id>,"ok":true,"bye":true}
# Errors are reported as a single line: ERR <id> <message>
#
# The optional "#<id>" request prefix is echoed back in the response so the Node
# side can match responses to requests and ignore the unsolicited {"ready":true}
# startup line (and any late response from a timed-out request). Commands without
# a prefix still work and produce id-less responses.
#
# Everything is written to the raw stdout stream as UTF-8 without a BOM, so the
# Node side can decode lines as UTF-8 regardless of the Windows console code page.
# All Win32 work is done through an in-process Add-Type C# block (no csc/msbuild).

$ErrorActionPreference = 'Stop'

$script:OutStream = [Console]::OpenStandardOutput()
$script:Utf8 = New-Object System.Text.UTF8Encoding($false)

function Write-Line([string]$text) {
  $bytes = $script:Utf8.GetBytes([string]$text + "`n")
  $script:OutStream.Write($bytes, 0, $bytes.Length)
  $script:OutStream.Flush()
}

# Writes a JSON response, injecting the current request id right after the
# opening brace when the command was sent with a "#<id>" prefix.
function Write-Response([string]$json) {
  if ([string]::IsNullOrEmpty($script:ReqId)) {
    Write-Line $json
  } else {
    Write-Line ('{"id":' + $script:ReqId + ',' + $json.Substring(1))
  }
}

function ConvertTo-WindowObject($info) {
  return [ordered]@{
    hwnd      = [long]$info.hwnd
    title     = [string]$info.title
    pid       = [int]$info.pid
    className = [string]$info.className
    rect      = @([int]$info.x, [int]$info.y, [int]$info.w, [int]$info.h)
    minimized = [bool]$info.minimized
  }
}

function Invoke-ListCommand {
  $wins = [LivePreviewWin]::ListWindows()
  $items = New-Object System.Collections.Generic.List[string]
  foreach ($w in $wins) {
    $obj = [ordered]@{
      hwnd      = [long]$w.hwnd
      title     = [string]$w.title
      pid       = [int]$w.pid
      className = [string]$w.className
      rect      = @([int]$w.x, [int]$w.y, [int]$w.w, [int]$w.h)
    }
    $items.Add((ConvertTo-Json -InputObject $obj -Compress -Depth 4))
  }
  Write-Response ('{"ok":true,"windows":[' + ($items -join ',') + ']}')
}

function Invoke-InfoCommand([string[]]$parts) {
  if ($parts.Count -lt 2) { throw 'INFO requires: INFO <hwnd>' }
  $hwnd = 0L
  if (-not [long]::TryParse($parts[1], [ref]$hwnd)) { throw ('invalid hwnd: ' + $parts[1]) }
  $info = [LivePreviewWin]::GetInfo($hwnd)
  if ($null -eq $info) { throw ('window not found: ' + $hwnd) }
  $json = ConvertTo-Json -InputObject (ConvertTo-WindowObject $info) -Compress -Depth 4
  Write-Response ('{"ok":true,"window":' + $json + '}')
}

function Invoke-CaptureCommand([string[]]$parts) {
  if ($parts.Count -lt 4) { throw 'CAPTURE requires: CAPTURE <hwnd> <maxWidth> <quality>' }
  $hwnd = 0L
  if (-not [long]::TryParse($parts[1], [ref]$hwnd)) { throw ('invalid hwnd: ' + $parts[1]) }
  $maxWidth = 1600
  $quality = 72
  [void][int]::TryParse($parts[2], [ref]$maxWidth)
  [void][int]::TryParse($parts[3], [ref]$quality)
  if ($maxWidth -le 0) { $maxWidth = 1600 }
  if ($maxWidth -gt 8192) { $maxWidth = 8192 }
  if ($quality -lt 1) { $quality = 72 }
  if ($quality -gt 100) { $quality = 100 }

  $bytes = [LivePreviewWin]::CaptureJpeg($hwnd, $maxWidth, $quality)
  $idPart = ''
  if (-not [string]::IsNullOrEmpty($script:ReqId)) { $idPart = $script:ReqId + ' ' }
  Write-Line ('FRAME ' + $idPart + [Convert]::ToBase64String($bytes))
}

function Invoke-ActivateCommand([string[]]$parts) {
  if ($parts.Count -lt 2) { throw 'ACTIVATE requires: ACTIVATE <hwnd>' }
  $hwnd = 0L
  if (-not [long]::TryParse($parts[1], [ref]$hwnd)) { throw ('invalid hwnd: ' + $parts[1]) }
  if (-not [LivePreviewWin]::ActivateWindow($hwnd)) { throw ('window not found: ' + $hwnd) }
  Write-Response ('{"ok":true,"hwnd":' + $hwnd + '}')
}

function Invoke-MinimizeCommand([string[]]$parts) {
  if ($parts.Count -lt 2) { throw 'MINIMIZE requires: MINIMIZE <hwnd>' }
  $hwnd = 0L
  if (-not [long]::TryParse($parts[1], [ref]$hwnd)) { throw ('invalid hwnd: ' + $parts[1]) }
  $ok = [LivePreviewWin]::MinimizeWindow($hwnd)
  if (-not $ok) { throw ('window not found or minimize failed: ' + $hwnd) }
  Write-Response ('{"ok":true,"hwnd":' + $hwnd + ',"minimized":true}')
}

function Invoke-OffscreenCommand([string[]]$parts) {
  if ($parts.Count -lt 2) { throw 'OFFSCREEN requires: OFFSCREEN <hwnd>' }
  $hwnd = 0L
  if (-not [long]::TryParse($parts[1], [ref]$hwnd)) { throw ('invalid hwnd: ' + $parts[1]) }
  $ok = [LivePreviewWin]::MoveOffscreen($hwnd)
  if (-not $ok) { throw ('window not found or move failed: ' + $hwnd) }
  Write-Response ('{"ok":true,"hwnd":' + $hwnd + ',"offscreen":true}')
}

function Invoke-OnscreenCommand([string[]]$parts) {
  if ($parts.Count -lt 2) { throw 'ONSCREEN requires: ONSCREEN <hwnd>' }
  $hwnd = 0L
  if (-not [long]::TryParse($parts[1], [ref]$hwnd)) { throw ('invalid hwnd: ' + $parts[1]) }
  $ok = [LivePreviewWin]::MoveOnscreen($hwnd)
  if (-not $ok) { throw ('window not found or move failed: ' + $hwnd) }
  Write-Response ('{"ok":true,"hwnd":' + $hwnd + ',"onscreen":true}')
}

try {
  Add-Type -AssemblyName System.Drawing
  Add-Type -Language CSharp -ReferencedAssemblies 'System.Drawing' -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

// Native Windows window enumeration + capture used by host/windows.ps1.
public static class LivePreviewWin
{
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    public sealed class WinInfo
    {
        public long hwnd;
        public string title;
        public int pid;
        public string className;
        public int x;
        public int y;
        public int w;
        public int h;
        public bool minimized;
    }

    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    private const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
    private const int DWMWA_CLOAKED = 14;
    private const uint PW_RENDERFULLCONTENT = 2;
    private const uint SRCCOPY = 0x00CC0020;
    private const int SW_RESTORE = 9;
    private const int SW_MINIMIZE = 6;
    private const uint SWP_NOSIZE = 0x0001;
    private const uint SWP_NOZORDER = 0x0004;
    private const uint SWP_NOACTIVATE = 0x0010;

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    [DllImport("user32.dll")]
    private static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")]
    private static extern bool IsHungAppWindow(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hWnd, StringBuilder className, int maxCount);
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")]
    private static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
    [DllImport("user32.dll")]
    private static extern IntPtr GetWindowDC(IntPtr hWnd);
    [DllImport("user32.dll")]
    private static extern int ReleaseDC(IntPtr hWnd, IntPtr hdc);
    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hWnd, int cmd);
    [DllImport("user32.dll")]
    private static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")]
    private static extern bool SetProcessDPIAware();
    [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")]
    private static extern int DwmGetWindowAttributeRect(IntPtr hWnd, int attr, out RECT rect, int size);
    [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")]
    private static extern int DwmGetWindowAttributeInt(IntPtr hWnd, int attr, out int value, int size);
    [DllImport("gdi32.dll")]
    private static extern bool BitBlt(IntPtr destDc, int x, int y, int w, int h, IntPtr srcDc, int srcX, int srcY, uint rop);
    [DllImport("gdi32.dll")]
    private static extern uint GetPixel(IntPtr hdc, int x, int y);

    private static ImageCodecInfo _jpegCodec;

    // Make the process per-monitor DPI aware so window rects and PrintWindow output
    // are expressed in physical pixels. Safe to call once; harmless if it fails.
    public static void Init()
    {
        try { SetProcessDPIAware(); } catch { }
    }

    public static List<WinInfo> ListWindows()
    {
        List<WinInfo> list = new List<WinInfo>();
        EnumWindowsProc callback = delegate(IntPtr hWnd, IntPtr lParam)
        {
            try
            {
                if (!IsWindowVisible(hWnd)) return true;
                if (IsCloaked(hWnd)) return true;
                int len = GetWindowTextLength(hWnd);
                if (len <= 0) return true;
                string title = GetTitle(hWnd);
                if (string.IsNullOrEmpty(title)) return true;
                string cn = GetClass(hWnd);
                if (cn == "Progman" || cn == "WorkerW" || cn == "Shell_TrayWnd" || cn == "Shell_SecondaryTrayWnd") return true;
                RECT r;
                if (!GetVisibleRect(hWnd, out r)) return true;
                int w = r.Right - r.Left;
                int h = r.Bottom - r.Top;
                if (w <= 0 || h <= 0) return true;
                WinInfo wi = new WinInfo();
                wi.hwnd = hWnd.ToInt64();
                wi.title = title;
                wi.pid = (int)GetPid(hWnd);
                wi.className = cn;
                wi.x = r.Left;
                wi.y = r.Top;
                wi.w = w;
                wi.h = h;
                wi.minimized = IsIconic(hWnd);
                list.Add(wi);
            }
            catch { }
            return true;
        };
        EnumWindows(callback, IntPtr.Zero);
        GC.KeepAlive(callback);
        return list;
    }

    public static WinInfo GetInfo(long hwndLong)
    {
        IntPtr hwnd = new IntPtr(hwndLong);
        if (hwndLong == 0 || !IsWindow(hwnd)) return null;
        RECT r;
        if (!GetVisibleRect(hwnd, out r)) return null;
        int w = r.Right - r.Left;
        int h = r.Bottom - r.Top;
        if (w <= 0 || h <= 0) return null;
        WinInfo wi = new WinInfo();
        wi.hwnd = hwndLong;
        wi.title = GetTitle(hwnd);
        wi.pid = (int)GetPid(hwnd);
        wi.className = GetClass(hwnd);
        wi.x = r.Left;
        wi.y = r.Top;
        wi.w = w;
        wi.h = h;
        wi.minimized = IsIconic(hwnd);
        return wi;
    }

    public static bool ActivateWindow(long hwndLong)
    {
        IntPtr hwnd = new IntPtr(hwndLong);
        if (hwndLong == 0 || !IsWindow(hwnd)) return false;
        if (IsIconic(hwnd)) ShowWindow(hwnd, SW_RESTORE);
        return SetForegroundWindow(hwnd);
    }

    /** 最小化窗口（不抢焦点）。 */
    public static bool MinimizeWindow(long hwndLong)
    {
        IntPtr hwnd = new IntPtr(hwndLong);
        if (hwndLong == 0 || !IsWindow(hwnd)) return false;
        return ShowWindow(hwnd, SW_MINIMIZE);
    }

    /**
     * 把窗口移到屏幕外并保持可见：既不会盖住 DSH，PrintWindow 也还能正常捕获
     * （最小化后的窗口 PrintWindow 会得到黑图，所以这里不是 SW_MINIMIZE）。
     */
    public static bool MoveOffscreen(long hwndLong)
    {
        IntPtr hwnd = new IntPtr(hwndLong);
        if (hwndLong == 0 || !IsWindow(hwnd)) return false;
        if (IsIconic(hwnd)) ShowWindow(hwnd, SW_RESTORE);
        RECT r;
        if (!GetWindowRect(hwnd, out r)) return false;
        int w = r.Right - r.Left;
        int h = r.Bottom - r.Top;
        if (w <= 0) w = 800;
        if (h <= 0) h = 600;
        return SetWindowPos(hwnd, IntPtr.Zero, -32000, -32000, w, h, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
    }

    /** 窗口是否已经在屏幕外，避免每秒重复移动。 */
    public static bool IsOffscreen(long hwndLong)
    {
        IntPtr hwnd = new IntPtr(hwndLong);
        if (hwndLong == 0 || !IsWindow(hwnd)) return false;
        RECT r;
        if (!GetWindowRect(hwnd, out r)) return false;
        return r.Left <= -30000 || r.Top <= -30000;
    }

    /** 把被移到屏幕外的窗口拿回屏幕左上角（尺寸保持），并置前。 */
    public static bool MoveOnscreen(long hwndLong)
    {
        IntPtr hwnd = new IntPtr(hwndLong);
        if (hwndLong == 0 || !IsWindow(hwnd)) return false;
        if (IsIconic(hwnd)) ShowWindow(hwnd, SW_RESTORE);
        RECT r;
        if (!GetWindowRect(hwnd, out r)) return false;
        int w = r.Right - r.Left;
        int h = r.Bottom - r.Top;
        if (w <= 0) w = 1000;
        if (h <= 0) h = 700;
        bool ok = SetWindowPos(hwnd, IntPtr.Zero, 120, 120, w, h, SWP_NOZORDER | SWP_NOACTIVATE);
        SetForegroundWindow(hwnd);
        return ok;
    }

    // Capture a window into a JPEG byte array. PrintWindow(PW_RENDERFULLCONTENT)
    // first, falling back to BitBlt from the window DC when PrintWindow fails,
    // returns a blank bitmap, or the window's UI thread is hung.
    public static byte[] CaptureJpeg(long hwndLong, int maxWidth, int quality)
    {
        IntPtr hwnd = new IntPtr(hwndLong);
        if (hwndLong == 0 || !IsWindow(hwnd)) throw new Exception("window not found: " + hwndLong);
        if (IsIconic(hwnd)) throw new Exception("window is minimized: " + hwndLong);

        RECT wr;
        if (!GetWindowRect(hwnd, out wr)) throw new Exception("GetWindowRect failed: " + hwndLong);
        int ww = wr.Right - wr.Left;
        int wh = wr.Bottom - wr.Top;
        if (ww <= 0 || wh <= 0) throw new Exception("window has no visible area: " + hwndLong);

        // The DWM "extended frame bounds" are the actually visible frame (the
        // GetWindowRect box includes the invisible resize/shadow border). Crop
        // to them so the returned image matches the rect reported by LIST/INFO.
        RECT vr;
        bool haveVisible = DwmGetWindowAttributeRect(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, out vr, Marshal.SizeOf(typeof(RECT))) == 0;
        int vw = vr.Right - vr.Left;
        int vh = vr.Bottom - vr.Top;
        bool crop = haveVisible && vw > 0 && vh > 0
            && vr.Left >= wr.Left && vr.Top >= wr.Top
            && vr.Right <= wr.Right && vr.Bottom <= wr.Bottom
            && (vw != ww || vh != wh);

        using (Bitmap full = new Bitmap(ww, wh, PixelFormat.Format24bppRgb))
        {
            DrawWindow(hwnd, full, ww, wh);
            if (!crop) return EncodeJpeg(full, maxWidth, quality);
            Rectangle cr = new Rectangle(vr.Left - wr.Left, vr.Top - wr.Top, vw, vh);
            using (Bitmap cropped = full.Clone(cr, full.PixelFormat))
            {
                return EncodeJpeg(cropped, maxWidth, quality);
            }
        }
    }

    private static void DrawWindow(IntPtr hwnd, Bitmap target, int w, int h)
    {
        using (Graphics g = Graphics.FromImage(target))
        {
            IntPtr hdc = g.GetHdc();
            try
            {
                bool printOk = false;
                if (!IsHungAppWindow(hwnd)) printOk = PrintWindow(hwnd, hdc, PW_RENDERFULLCONTENT);
                bool blank = printOk && IsBlankHdc(hdc, w, h);
                if (!printOk || blank)
                {
                    IntPtr srcDc = GetWindowDC(hwnd);
                    if (srcDc != IntPtr.Zero)
                    {
                        try { BitBlt(hdc, 0, 0, w, h, srcDc, 0, 0, SRCCOPY); }
                        finally { ReleaseDC(hwnd, srcDc); }
                    }
                }
            }
            finally
            {
                g.ReleaseHdc(hdc);
            }
        }
    }

    // A 10x10 sample grid is enough to detect the classic PrintWindow failure
    // mode (fully black/transparent bitmap) at a negligible cost.
    private static bool IsBlankHdc(IntPtr hdc, int w, int h)
    {
        int stepX = Math.Max(1, w / 10);
        int stepY = Math.Max(1, h / 10);
        for (int y = stepY / 2; y < h; y += stepY)
        {
            for (int x = stepX / 2; x < w; x += stepX)
            {
                uint color = GetPixel(hdc, x, y) & 0x00FFFFFF;
                if (color != 0) return false;
            }
        }
        return true;
    }

    private static byte[] EncodeJpeg(Bitmap src, int maxWidth, int quality)
    {
        if (maxWidth <= 0 || src.Width <= maxWidth)
        {
            using (MemoryStream ms = new MemoryStream())
            {
                EncoderParameters eps = new EncoderParameters(1);
                eps.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)quality);
                try { src.Save(ms, GetJpegCodec(), eps); }
                finally { eps.Dispose(); }
                return ms.ToArray();
            }
        }
        int nw = maxWidth;
        int nh = (int)Math.Round((double)src.Height * maxWidth / src.Width);
        if (nh < 1) nh = 1;
        using (Bitmap scaled = new Bitmap(nw, nh, PixelFormat.Format24bppRgb))
        {
            using (Graphics sg = Graphics.FromImage(scaled))
            {
                sg.InterpolationMode = InterpolationMode.HighQualityBilinear;
                sg.PixelOffsetMode = PixelOffsetMode.HighQuality;
                sg.SmoothingMode = SmoothingMode.None;
                sg.DrawImage(src, new Rectangle(0, 0, nw, nh));
            }
            return EncodeJpeg(scaled, 0, quality);
        }
    }

    private static ImageCodecInfo GetJpegCodec()
    {
        if (_jpegCodec == null)
        {
            foreach (ImageCodecInfo codec in ImageCodecInfo.GetImageEncoders())
            {
                if (codec.MimeType == "image/jpeg") { _jpegCodec = codec; break; }
            }
        }
        if (_jpegCodec == null) throw new Exception("no JPEG encoder available");
        return _jpegCodec;
    }

    private static bool GetVisibleRect(IntPtr hwnd, out RECT rect)
    {
        RECT ext;
        if (DwmGetWindowAttributeRect(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, out ext, Marshal.SizeOf(typeof(RECT))) == 0)
        {
            if (ext.Right - ext.Left > 0 && ext.Bottom - ext.Top > 0) { rect = ext; return true; }
        }
        return GetWindowRect(hwnd, out rect);
    }

    private static bool IsCloaked(IntPtr hwnd)
    {
        int cloaked;
        if (DwmGetWindowAttributeInt(hwnd, DWMWA_CLOAKED, out cloaked, sizeof(int)) == 0) return cloaked != 0;
        return false;
    }

    private static string GetTitle(IntPtr hwnd)
    {
        int len = GetWindowTextLength(hwnd);
        if (len <= 0) return "";
        StringBuilder sb = new StringBuilder(len + 2);
        GetWindowText(hwnd, sb, sb.Capacity);
        return sb.ToString();
    }

    private static string GetClass(IntPtr hwnd)
    {
        StringBuilder sb = new StringBuilder(256);
        GetClassName(hwnd, sb, sb.Capacity);
        return sb.ToString();
    }

    private static uint GetPid(IntPtr hwnd)
    {
        uint pid;
        GetWindowThreadProcessId(hwnd, out pid);
        return pid;
    }
}
'@
  # Compile happened above; now finish initialization.
  [LivePreviewWin]::Init()
  Write-Line ('{"ok":true,"ready":true,"pid":' + $PID + '}')
}
catch {
  $msg = [string]$_.Exception.Message
  if (-not $msg) { $msg = 'unknown init error' }
  $msg = $msg -replace '[\r\n]+', ' '
  try { Write-Line ('ERR init failed: ' + $msg) } catch { }
  exit 1
}

$script:ReqId = ''
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line -eq '') { continue }
  $parts = [string[]]($line -split '\s+')
  $script:ReqId = ''
  if ($parts.Count -gt 1 -and $parts[0] -match '^#(\d{1,12})$') {
    $script:ReqId = $Matches[1]
    $parts = [string[]]$parts[1..($parts.Count - 1)]
  }
  $cmd = $parts[0].ToUpperInvariant()
  try {
    switch ($cmd) {
      'LIST' { Invoke-ListCommand }
      'INFO' { Invoke-InfoCommand -parts $parts }
      'CAPTURE' { Invoke-CaptureCommand -parts $parts }
      'ACTIVATE' { Invoke-ActivateCommand -parts $parts }
      'MINIMIZE' { Invoke-MinimizeCommand -parts $parts }
      'OFFSCREEN' { Invoke-OffscreenCommand -parts $parts }
      'ONSCREEN' { Invoke-OnscreenCommand -parts $parts }
      'EXIT' { Write-Response '{"ok":true,"bye":true}'; exit 0 }
      default { throw ('unknown command: ' + $cmd) }
    }
  }
  catch {
    # Static C# method failures surface as MethodInvocationException; report the
    # inner message so clients get e.g. "window is minimized: 12345" instead of
    # the localized PowerShell invocation wrapper.
    $ex = $_.Exception
    if ($ex -is [System.Management.Automation.MethodInvocationException] -and $null -ne $ex.InnerException) {
      $msg = [string]$ex.InnerException.Message
    } else {
      $msg = [string]$ex.Message
    }
    if (-not $msg) { $msg = 'unknown error' }
    $msg = $msg -replace '[\r\n]+', ' '
    if ($msg.Length -gt 800) { $msg = $msg.Substring(0, 800) }
    $idPart = ''
    if (-not [string]::IsNullOrEmpty($script:ReqId)) { $idPart = $script:ReqId + ' ' }
    try { Write-Line ('ERR ' + $idPart + $msg) } catch { exit 1 }
  }
}
