"""Medição somente leitura do impacto da sessão do Remote v2 na TV.

Responde, com números, se manter a sessão aberta piora a TV (o limpador do sistema já mata o serviço
do controle remoto algumas vezes por hora) e quanto custa reabrir a sessão depois de hibernar.

Uso (da pasta `apps/agent`, com a TV ligada e o app de vídeo de sempre aberto):

    uv run python tools/measure_tv_session.py kills --adb C:/caminho/adb.exe \\
        --serial 192.168.0.4:5555 --host 192.168.0.4 --minutes 60 [--session]
    uv run python tools/measure_tv_session.py memory --adb ... --serial ... --label sem-sessao
    uv run python tools/measure_tv_session.py memory --adb ... --serial ... --label com-sessao \\
        --host 192.168.0.4 --session
    uv run python tools/measure_tv_session.py reconnect --host 192.168.0.4 --repetitions 20

O que cada modo mede:

* `kills`: quantas vezes o limpador matou o serviço do controle (linhas `tguard-kill` do `logcat`)
  e como ficaram as portas 6466 e 6467 (amostra a cada 10 s). Rode sem e com `--session`.
* `memory`: memória do serviço do controle, do `adbd` e `MemAvailable`/zram, antes e depois.
* `reconnect`: tempo do `connect` do Remote v2 até a TV ficar pronta para receber teclas,
  repetido; informa mediana e p95. Cada repetição abre e fecha a sessão de verdade.

Teclas durante vídeo e no Netflix não se automatizam: o resultado depende de olhar a tela.

**Antes de medir, pare o agente (`uniover-agent run`) e a tarefa agendada do vigia antigo.** Esta
ferramenta usa o mesmo certificado do agente e o ADB aceita um cliente por vez: com outro dono na TV
as sessões disputam a conexão e as medições saem contaminadas.

**Somente leitura, sempre.** O ADB só roda comandos da lista fixa abaixo (nenhum `input`, nenhum
`am`, nenhum `svc`), e nenhuma tecla de energia (POWER, SLEEP, WAKEUP...) é enviada, nem por engano:
a TV não tem botão físico e sem infravermelho não volta do standby. O modo `reconnect` não envia
tecla nenhuma; só conecta e desconecta.
"""

import argparse
import asyncio
import itertools
import json
import re
import shutil
import socket
import statistics
import subprocess
import sys
import time
from collections.abc import Callable, Sequence
from datetime import UTC, datetime
from pathlib import Path
from typing import Final

from uniover_agent.adapters.system_clock import SystemClock
from uniover_agent.adapters.tv_remote_v2 import AndroidTvRemoteV2
from uniover_agent.config import tv_cert_dir
from uniover_agent.core import TvSessionManager

REMOTE_SERVICE: Final = "com.google.android.tv.remote.service"
PORTS: Final = (6466, 6467)
SAMPLE_SECONDS: Final = 10.0
COLLECT_SECONDS: Final = 60.0
PORT_TIMEOUT_SECONDS: Final = 2.0
SETTLE_SECONDS: Final = 3.0
ADB_TIMEOUT_SECONDS: Final = 30.0

# Os únicos comandos que o ADB executa aqui. Todos só leem.
READ_ONLY_ADB: Final[dict[str, tuple[str, ...]]] = {
    # `-e` filtra no próprio aparelho: o buffer inteiro não atravessa a rede (pouca memória na TV).
    "logcat_kills": ("logcat", "-d", "-b", "all", "-e", "tguard-kill"),
    "logcat_buffers": ("logcat", "-g"),
    "meminfo_service": ("shell", "dumpsys", "meminfo", REMOTE_SERVICE),
    "proc_meminfo": ("shell", "cat", "/proc/meminfo"),
    "swaps": ("shell", "cat", "/proc/swaps"),
    "zram_stat": ("shell", "cat", "/sys/block/zram0/mm_stat"),
    "processes": ("shell", "ps", "-A", "-o", "PID,RSS,NAME"),
}

_PS_COLUMNS: Final = 3  # PID, RSS, NAME
KILL_PATTERN: Final = re.compile(r"tguard-kill", re.IGNORECASE)


def run_adb(adb: Path, serial: str, name: str) -> str:
    """Roda um comando da lista fixa e devolve a saída de texto."""
    if name not in READ_ONLY_ADB:
        raise SystemExit(f"comando ADB fora da lista somente leitura: {name}")
    command = [str(adb), "-s", serial, *READ_ONLY_ADB[name]]
    done = subprocess.run(  # noqa: S603 - executável informado pelo usuário, argumentos da lista fixa
        command,
        capture_output=True,
        text=True,
        timeout=ADB_TIMEOUT_SECONDS,
        check=False,
        encoding="utf-8",
        errors="replace",
    )
    return (
        done.stdout if done.returncode == 0 else f"[erro {done.returncode}] {done.stderr.strip()}"
    )


def port_open(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.settimeout(PORT_TIMEOUT_SECONDS)
        return probe.connect_ex((host, port)) == 0


def kill_lines(logcat: str) -> set[str]:
    """Linhas `tguard-kill` distintas. Cada linha traz o horário, então duas mortes não se fundem
    e a mesma morte, lida de novo numa coleta seguinte, não é contada duas vezes."""
    return {line.strip() for line in logcat.splitlines() if KILL_PATTERN.search(line)}


def count_port_drops(samples: Sequence[bool]) -> int:
    """Quedas de uma porta: passagens de aberta para fechada entre amostras seguidas."""
    return sum(1 for before, after in itertools.pairwise(samples) if before and not after)


def percentile(values: Sequence[float], fraction: float) -> float:
    """Percentil por posição mais próxima (com 20 amostras, p95 é a 19ª)."""
    ordered = sorted(values)
    index = max(0, min(len(ordered) - 1, round(fraction * len(ordered)) - 1))
    return ordered[index]


def summarize(values: Sequence[float]) -> dict[str, float]:
    return {
        "n": float(len(values)),
        "median": statistics.median(values),
        "p95": percentile(values, 0.95),
        "min": min(values),
        "max": max(values),
    }


def meminfo_fields(text: str) -> dict[str, int]:
    """`MemAvailable` e afins em kB, de `/proc/meminfo`."""
    fields: dict[str, int] = {}
    for line in text.splitlines():
        match = re.match(r"^(\w+):\s+(\d+)\s*kB", line)
        if match and match.group(1) in {"MemTotal", "MemFree", "MemAvailable", "SwapFree"}:
            fields[match.group(1)] = int(match.group(2))
    return fields


def process_rss_kb(text: str, name: str) -> int | None:
    for line in text.splitlines():
        parts = line.split()
        if len(parts) >= _PS_COLUMNS and parts[2] == name and parts[1].isdigit():
            return int(parts[1])
    return None


def open_session(host: str, tv_name: str, client_name: str) -> TvSessionManager:
    """Sessão do agente com hibernação desligada na prática (a medição quer a sessão aberta)."""
    adapter = AndroidTvRemoteV2(host, client_name, tv_cert_dir(tv_name))
    return TvSessionManager(SystemClock(), adapter, hibernate_seconds=10**9)


def emit(out: Path | None, record: dict[str, object]) -> None:
    record["at"] = datetime.now(UTC).isoformat(timespec="seconds")
    line = json.dumps(record, ensure_ascii=False)
    print(line)
    if out is not None:
        with out.open("a", encoding="utf-8") as handle:
            handle.write(line + "\n")


async def collect_kills(args: argparse.Namespace) -> set[str]:
    return kill_lines(await asyncio.to_thread(run_adb, args.adb, args.serial, "logcat_kills"))


async def measure_kills(args: argparse.Namespace) -> None:
    """Conta mortes por duas vias.

    O `logcat` é um buffer circular: com a TV carregada ele dá a volta e uma leitura só, no fim,
    perderia mortes. Por isso a coleta se repete a cada minuto e conta linhas distintas. A segunda
    via, independente do log, são as quedas da porta 6466 entre as amostras de 10 s.
    """
    manager = open_session(args.host, args.tv_name, args.client_name) if args.session else None
    if manager is not None:
        await manager.wake()
        print("sessão do Remote v2 aberta; nenhuma tecla será enviada")
    buffers_before = run_adb(args.adb, args.serial, "logcat_buffers").strip()
    baseline = await collect_kills(args)
    seen = set(baseline)
    samples: dict[int, list[bool]] = {port: [] for port in PORTS}
    started = time.monotonic()
    deadline = started + args.minutes * 60
    next_collect = started + COLLECT_SECONDS
    try:
        while time.monotonic() < deadline:
            for port in PORTS:
                samples[port].append(await asyncio.to_thread(port_open, args.host, port))
            if time.monotonic() >= next_collect:
                seen |= await collect_kills(args)
                next_collect += COLLECT_SECONDS
            await asyncio.sleep(SAMPLE_SECONDS)
    finally:
        if manager is not None:
            await manager.aclose()
    seen |= await collect_kills(args)
    new_kills = seen - baseline
    hours = args.minutes / 60
    emit(
        args.out,
        {
            "measurement": "kills",
            "session": bool(args.session),
            "minutes": args.minutes,
            "kills_in_log": len(new_kills),
            "kills_per_hour_log": round(len(new_kills) / hours, 2),
            "port_drops": {str(port): count_port_drops(samples[port]) for port in PORTS},
            "ports_closed_samples": {str(port): samples[port].count(False) for port in PORTS},
            "samples_per_port": len(samples[PORTS[0]]),
            "log_buffers_before": buffers_before,
            "log_buffers_after": run_adb(args.adb, args.serial, "logcat_buffers").strip(),
        },
    )


async def measure_memory(args: argparse.Namespace) -> None:
    manager = open_session(args.host, args.tv_name, args.client_name) if args.session else None
    try:
        if manager is not None:
            await manager.wake()
            await asyncio.sleep(SETTLE_SECONDS)
        meminfo = meminfo_fields(run_adb(args.adb, args.serial, "proc_meminfo"))
        processes = run_adb(args.adb, args.serial, "processes")
        emit(
            args.out,
            {
                "measurement": "memory",
                "label": args.label,
                "session": bool(args.session),
                "proc_meminfo_kb": meminfo,
                "adbd_rss_kb": process_rss_kb(processes, "adbd"),
                "remote_service_rss_kb": process_rss_kb(processes, REMOTE_SERVICE),
                "zram_mm_stat": run_adb(args.adb, args.serial, "zram_stat").strip(),
                "swaps": run_adb(args.adb, args.serial, "swaps").strip(),
                "remote_service_meminfo": run_adb(args.adb, args.serial, "meminfo_service")
                .strip()
                .splitlines()[:40],
            },
        )
    finally:
        if manager is not None:
            await manager.aclose()


async def measure_reconnect(args: argparse.Namespace) -> None:
    durations: list[float] = []
    for repetition in range(args.repetitions):
        manager = open_session(args.host, args.tv_name, args.client_name)
        started = time.monotonic()
        try:
            await manager.wake()
        finally:
            elapsed = time.monotonic() - started
            await manager.aclose()
        durations.append(elapsed)
        print(f"repetição {repetition + 1}/{args.repetitions}: {elapsed:.3f} s")
        await asyncio.sleep(SETTLE_SECONDS)
    emit(
        args.out,
        {"measurement": "reconnect", "seconds": summarize(durations), "samples": durations},
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Medição somente leitura da sessão da TV.")
    parser.add_argument("--out", type=Path, help="arquivo .jsonl que recebe cada resultado")
    parser.add_argument("--tv-name", default="tv", help="pasta do certificado (UNIOVER_TV_NAME)")
    parser.add_argument("--client-name", default="UniOver")
    sub = parser.add_subparsers(dest="mode", required=True)

    def adb_options(command: argparse.ArgumentParser) -> None:
        command.add_argument("--adb", type=Path, required=True, help="caminho completo do adb.exe")
        command.add_argument("--serial", required=True, help="IP:porta do ADB da TV")
        command.add_argument("--host", required=True, help="IP da TV")
        command.add_argument("--session", action="store_true", help="mantém o Remote v2 aberto")

    kills = sub.add_parser("kills", help="mortes do serviço do controle e estado das portas")
    adb_options(kills)
    kills.add_argument("--minutes", type=float, default=60.0)
    memory = sub.add_parser("memory", help="memória da TV")
    adb_options(memory)
    memory.add_argument("--label", required=True, help="ex.: sem-sessao, com-sessao")
    reconnect = sub.add_parser("reconnect", help="tempo de religação do Remote v2")
    reconnect.add_argument("--host", required=True)
    reconnect.add_argument("--repetitions", type=int, default=20)
    return parser


HANDLERS: Final[dict[str, Callable[[argparse.Namespace], object]]] = {
    "kills": measure_kills,
    "memory": measure_memory,
    "reconnect": measure_reconnect,
}


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if hasattr(args, "adb") and not (args.adb.is_file() or shutil.which(str(args.adb))):
        print(f"adb não encontrado: {args.adb}", file=sys.stderr)
        return 1
    asyncio.run(HANDLERS[args.mode](args))  # type: ignore[arg-type]
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
