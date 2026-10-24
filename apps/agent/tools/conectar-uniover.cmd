@echo off
rem Conecta este computador ao UniOver: baixa o instalador, acha a TV, pareia e deixa tudo iniciando sozinho.
powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; & ([scriptblock]::Create((irm https://raw.githubusercontent.com/n33miaz/uniover/main/apps/agent/tools/install-windows.ps1)))"
pause
