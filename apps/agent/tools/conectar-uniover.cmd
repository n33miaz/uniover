@echo off
rem Conecta este computador ao UniOver: baixa o instalador, liga o PC ao celular, acha a TV e deixa tudo iniciando sozinho.
rem Nenhuma janela de console fica aberta: este arquivo so cria um script do Windows Script Host (que nao tem console) e
rem sai na hora; o instalador roda oculto (num console sem janela, conhost --headless, a partir do Windows 10 2004, para o
rem Terminal do Windows nunca abrir uma janela para ele) e mostra o andamento numa pagina no navegador.
set "UO_VBS=%TEMP%\conectar-uniover-%RANDOM%.vbs"
>"%UO_VBS%" echo Set s = CreateObject("WScript.Shell")
>>"%UO_VBS%" echo c = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command ""[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; $r='develop'; try { $v=(irm https://raw.githubusercontent.com/n33miaz/uniover/main/apps/agent/tools/update-channel.json).production_ref; if ($v -in @('main','develop','homolog')) { $r=$v } } catch {}; & ([scriptblock]::Create((irm ('https://raw.githubusercontent.com/n33miaz/uniover/'+$r+'/apps/agent/tools/install-windows.ps1'))))"""
>>"%UO_VBS%" echo b = 0
>>"%UO_VBS%" echo On Error Resume Next
>>"%UO_VBS%" echo b = CLng(s.RegRead("HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\CurrentBuildNumber"))
>>"%UO_VBS%" echo On Error GoTo 0
>>"%UO_VBS%" echo If b ^>= 19041 Then c = s.ExpandEnvironmentStrings("%%SystemRoot%%") ^& "\System32\conhost.exe --headless " ^& c
>>"%UO_VBS%" echo s.Run c, 0, False
>>"%UO_VBS%" echo CreateObject("Scripting.FileSystemObject").DeleteFile WScript.ScriptFullName
start "" wscript.exe //B //Nologo "%UO_VBS%"
exit
