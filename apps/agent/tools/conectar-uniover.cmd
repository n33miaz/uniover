@echo off
rem Conecta este computador ao UniOver: baixa o instalador, acha a TV, pareia e deixa tudo iniciando sozinho.
rem Nenhuma janela de console fica aberta: este arquivo so cria um script do Windows Script Host (que nao tem
rem console) e sai na hora; o instalador roda oculto e mostra o andamento numa pagina no navegador.
set "UO_VBS=%TEMP%\conectar-uniover-%RANDOM%.vbs"
>"%UO_VBS%" echo Set s = CreateObject("WScript.Shell")
>>"%UO_VBS%" echo s.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command ""[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; & ([scriptblock]::Create((irm https://raw.githubusercontent.com/n33miaz/uniover/main/apps/agent/tools/install-windows.ps1)))""", 0, False
>>"%UO_VBS%" echo CreateObject("Scripting.FileSystemObject").DeleteFile WScript.ScriptFullName
start "" wscript.exe //B //Nologo "%UO_VBS%"
exit
