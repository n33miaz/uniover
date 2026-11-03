param([Parameter(Mandatory = $true)][string]$StatePath, [switch]$Probe, [int]$ProbeHoldSeconds = 0)

# Processo visual da bandeja. Recebe estado por arquivo atomico e devolve somente nomes de acoes no stdout.
# O processo Python continua dono do comportamento e volta ao pystray se este host nao abrir.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type -ReferencedAssemblies @('System.Windows.Forms.dll', 'System.Drawing.dll') -TypeDefinition @'
using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;
public static class UniOverTrayNative {
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct Identifier {
        public uint Size; public IntPtr Window; public uint Id; public Guid Guid;
    }
    [DllImport("shell32.dll", ExactSpelling=true)]
    public static extern int Shell_NotifyIconGetRect(ref Identifier id, out Rect rect);
    [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr window);
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr context);
}
public sealed class UniOverMenuColors : ProfessionalColorTable {
    public Color Surface = Color.White;
    public Color Selected = Color.FromArgb(232, 241, 233);
    public Color Border = Color.FromArgb(59, 107, 75);
    public override Color ToolStripDropDownBackground { get { return Surface; } }
    public override Color MenuItemSelected { get { return Selected; } }
    public override Color MenuItemSelectedGradientBegin { get { return Selected; } }
    public override Color MenuItemSelectedGradientEnd { get { return Selected; } }
    public override Color MenuItemBorder { get { return Border; } }
    public override Color SeparatorDark { get { return Border; } }
    public override Color SeparatorLight { get { return Surface; } }
}
'@

[void][UniOverTrayNative]::SetProcessDpiAwarenessContext([IntPtr](-4))
[System.Windows.Forms.Application]::EnableVisualStyles()
$initial = [System.IO.File]::ReadAllText($StatePath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
if (-not $initial.icon -or -not (Test-Path -LiteralPath $initial.icon)) { throw 'icone inicial ausente' }

$context = New-Object System.Windows.Forms.ApplicationContext
$icon = New-Object System.Windows.Forms.NotifyIcon
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$menu.ShowImageMargin = $false
$menu.ShowCheckMargin = $false
$menu.Padding = New-Object System.Windows.Forms.Padding(6)
$menu.RenderMode = [System.Windows.Forms.ToolStripRenderMode]::Professional
$colors = New-Object UniOverMenuColors
$brandedRenderer = New-Object System.Windows.Forms.ToolStripProfessionalRenderer($colors)
$menu.Renderer = $brandedRenderer
$heading = New-Object System.Windows.Forms.ToolStripLabel('UniOver')
$heading.Font = New-Object System.Drawing.Font('Segoe UI Semibold', 11, [System.Drawing.FontStyle]::Bold)
$heading.AutoSize = $false
$heading.Height = 40
$heading.AccessibleName = 'UniOver'
[void]$menu.Items.Add($heading)
$stateLabel = New-Object System.Windows.Forms.ToolStripLabel('Iniciando')
$stateLabel.AutoSize = $false
$stateLabel.Height = 35
$stateLabel.AccessibleName = 'Estado do agente: iniciando'
[void]$menu.Items.Add($stateLabel)
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
foreach ($entry in $initial.menu) {
    if ($null -eq $entry) {
        [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
        continue
    }
    $action = [string]$entry.action
    $item = New-Object System.Windows.Forms.ToolStripMenuItem([string]$entry.label)
    $item.Tag = $action
    $item.AutoSize = $false
    $item.Height = 42
    $item.AccessibleName = [string]$entry.label
    $item.add_Click({
        param($sender, $eventArgs)
        [Console]::Out.WriteLine('ACTION ' + $sender.Tag)
        [Console]::Out.Flush()
    })
    [void]$menu.Items.Add($item)
}
$icon.ContextMenuStrip = $menu
$icon.Icon = New-Object System.Drawing.Icon([string]$initial.icon)
$icon.Text = ([string]$initial.title).Substring(0, [Math]::Min(63, ([string]$initial.title).Length))
$icon.Visible = $true

$fields = [System.Reflection.BindingFlags]'NonPublic,Instance'
$nativeWindow = $icon.GetType().GetField('window', $fields).GetValue($icon)
$windowHandle = $nativeWindow.Handle
$iconId = [uint32]$icon.GetType().GetField('id', $fields).GetValue($icon)
if ($windowHandle -eq [IntPtr]::Zero -or $iconId -ne 1) { throw 'identificador estavel do icone indisponivel' }

function Get-IconRect {
    $identifier = New-Object UniOverTrayNative+Identifier
    $identifier.Size = [uint32][System.Runtime.InteropServices.Marshal]::SizeOf([type][UniOverTrayNative+Identifier])
    $identifier.Window = $windowHandle
    $identifier.Id = $iconId
    $rect = New-Object UniOverTrayNative+Rect
    if ([UniOverTrayNative]::Shell_NotifyIconGetRect([ref]$identifier, [ref]$rect) -ne 0) { return $null }
    return $rect
}

function Apply-Theme {
    $high = [System.Windows.Forms.SystemInformation]::HighContrast
    $light = 1
    try {
        $value = Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize' -Name AppsUseLightTheme -ErrorAction Stop
        $light = [int]$value.AppsUseLightTheme
    } catch { }
    if ($high) {
        $menu.RenderMode = [System.Windows.Forms.ToolStripRenderMode]::System
        $background = [System.Drawing.SystemColors]::Menu
        $foreground = [System.Drawing.SystemColors]::MenuText
        $accent = [System.Drawing.SystemColors]::Highlight
        $muted = [System.Drawing.SystemColors]::GrayText
    } elseif ($light -eq 0) {
        $menu.Renderer = $brandedRenderer
        $background = [System.Drawing.ColorTranslator]::FromHtml('#1e2820')
        $foreground = [System.Drawing.ColorTranslator]::FromHtml('#e9efea')
        $accent = [System.Drawing.ColorTranslator]::FromHtml('#98c4a3')
        $muted = [System.Drawing.ColorTranslator]::FromHtml('#b0bdb3')
        $selected = [System.Drawing.ColorTranslator]::FromHtml('#2f3b33')
    } else {
        $menu.Renderer = $brandedRenderer
        $background = [System.Drawing.ColorTranslator]::FromHtml('#ffffff')
        $foreground = [System.Drawing.ColorTranslator]::FromHtml('#17201a')
        $accent = [System.Drawing.ColorTranslator]::FromHtml('#3b6b4b')
        $muted = [System.Drawing.ColorTranslator]::FromHtml('#46544a')
        $selected = [System.Drawing.ColorTranslator]::FromHtml('#e8f1e9')
    }
    if (-not $high) {
        $colors.Surface = $background
        $colors.Selected = $selected
        $colors.Border = $accent
    }
    $menu.BackColor = $background
    $menu.ForeColor = $foreground
    $heading.ForeColor = $accent
    $stateLabel.ForeColor = $muted
    foreach ($item in $menu.Items) {
        if ($item -is [System.Windows.Forms.ToolStripMenuItem]) {
            $item.BackColor = $background
            $item.ForeColor = $foreground
        }
    }
}

function Apply-Dpi {
    $dpi = [UniOverTrayNative]::GetDpiForWindow($windowHandle)
    if ($dpi -lt 96) { $dpi = 96 }
    if ($dpi -eq $script:lastDpi) { return }
    $script:lastDpi = $dpi
    $scale = $dpi / 96.0
    $heading.Width = [int][Math]::Ceiling(252 * $scale)
    $heading.Height = [int][Math]::Ceiling(40 * $scale)
    $stateLabel.Width = [int][Math]::Ceiling(252 * $scale)
    $stateLabel.Height = [int][Math]::Ceiling(36 * $scale)
    foreach ($item in $menu.Items) {
        if ($item -is [System.Windows.Forms.ToolStripMenuItem]) {
            $item.Width = [int][Math]::Ceiling(252 * $scale)
            $item.Height = [int][Math]::Ceiling(42 * $scale)
        }
    }
}

function Place-Menu {
    $rect = Get-IconRect
    if ($null -eq $rect) { return }
    $center = New-Object System.Drawing.Point([int](($rect.Left + $rect.Right) / 2), [int](($rect.Top + $rect.Bottom) / 2))
    $work = [System.Windows.Forms.Screen]::FromPoint($center).WorkingArea
    $size = $menu.GetPreferredSize([System.Drawing.Size]::Empty)
    $x = $rect.Left
    $y = $rect.Top - $size.Height
    if ($rect.Bottom -le $work.Top + 2) { $y = $rect.Bottom }
    elseif ($rect.Left -ge $work.Right - 2) { $x = $rect.Left - $size.Width; $y = $rect.Top }
    elseif ($rect.Right -le $work.Left + 2) { $x = $rect.Right; $y = $rect.Top }
    $x = [Math]::Max($work.Left, [Math]::Min($x, $work.Right - $size.Width))
    $y = [Math]::Max($work.Top, [Math]::Min($y, $work.Bottom - $size.Height))
    $menu.Location = New-Object System.Drawing.Point($x, $y)
}

$menu.add_Opened({ Place-Menu })
$icon.add_MouseClick({ param($sender, $eventArgs)
    if ($eventArgs.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
        [Console]::Out.WriteLine('ACTION open')
        [Console]::Out.Flush()
    }
})

$lastState = ''
$lastTheme = ''
$lastDpi = 0
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 350
$timer.add_Tick({
    try {
        $theme = "{0}|{1}" -f [System.Windows.Forms.SystemInformation]::HighContrast, (Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize' -Name AppsUseLightTheme -ErrorAction SilentlyContinue).AppsUseLightTheme
        if ($theme -ne $lastTheme) { Apply-Theme; $script:lastTheme = $theme }
        Apply-Dpi
        $raw = [System.IO.File]::ReadAllText($StatePath, [System.Text.Encoding]::UTF8)
        if ($raw -eq $lastState) { return }
        $script:lastState = $raw
        $view = $raw | ConvertFrom-Json
        if ($view.exit) { $context.ExitThread(); return }
        $stateLabel.Text = [string]$view.status
        $stateLabel.AccessibleName = 'Estado do agente: ' + [string]$view.status
        $title = [string]$view.title
        $icon.Text = $title.Substring(0, [Math]::Min(63, $title.Length))
        if ([string]$view.icon -ne [string]$script:currentIcon) {
            $replacement = New-Object System.Drawing.Icon([string]$view.icon)
            $oldIcon = $icon.Icon
            $icon.Icon = $replacement
            $oldIcon.Dispose()
            $script:currentIcon = [string]$view.icon
        }
        if ($view.balloon -and $view.balloon.message) {
            $icon.BalloonTipTitle = [string]$view.balloon.title
            $icon.BalloonTipText = [string]$view.balloon.message
            $icon.ShowBalloonTip(5000)
        }
    } catch { [Console]::Error.WriteLine($_.Exception.Message) }
})

try {
    Apply-Theme
    Apply-Dpi
    if ($null -eq (Get-IconRect)) { throw 'o Windows nao registrou o icone da bandeja' }
    $timer.Start()
    [Console]::Out.WriteLine('READY')
    if ($Probe) {
        $rect = Get-IconRect
        if ($null -eq $rect) { [Console]::Out.WriteLine('RECT unavailable') }
        else {
            [Console]::Out.WriteLine("RECT $($rect.Left) $($rect.Top) $($rect.Right) $($rect.Bottom)")
            Place-Menu
            [Console]::Out.WriteLine("MENU $($menu.Location.X) $($menu.Location.Y)")
            $menu.Show((New-Object System.Drawing.Point($rect.Left, $rect.Top)))
            [System.Windows.Forms.Application]::DoEvents()
            [Console]::Out.WriteLine("OPEN $($menu.Location.X) $($menu.Location.Y) $($menu.Width) $($menu.Height)")
            if ($ProbeHoldSeconds -gt 0 -and $ProbeHoldSeconds -le 10) {
                Start-Sleep -Seconds $ProbeHoldSeconds
            }
            $menu.Close()
        }
    }
    [Console]::Out.Flush()
    [System.Windows.Forms.Application]::Run($context)
} finally {
    $timer.Stop()
    $timer.Dispose()
    $icon.Visible = $false
    if ($null -ne $icon.Icon) { $icon.Icon.Dispose() }
    $icon.Dispose()
    $menu.Dispose()
    $context.Dispose()
}
