"""Gera a chave Ed25519 e assina o manifesto de atualização do agente.

A chave privada nunca é escrita em arquivo por esta ferramenta. Quem a gerar deve guardar o valor
`AGENT_SIGNING_KEY` somente como segredo do ambiente protegido de publicação.
"""

import argparse
import base64
import json
import os
import sys
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey


def manifest_message(fields: dict[str, str | int]) -> bytes:
    """Mantém a serialização exatamente igual à verificada pelo agente."""
    return json.dumps(fields, ensure_ascii=True, separators=(",", ":"), sort_keys=True).encode(
        "ascii"
    )


def encoded_private_key(value: str) -> Ed25519PrivateKey:
    """Lê a semente Ed25519 de 32 bytes, em Base64, sem aceitá-la por argumento."""
    try:
        raw = base64.b64decode(value, validate=True)
        return Ed25519PrivateKey.from_private_bytes(raw)
    except (ValueError, TypeError) as exc:
        raise ValueError(
            "AGENT_SIGNING_KEY deve ser uma chave Ed25519 de 32 bytes em Base64"
        ) from exc


def generate_key() -> int:
    """Imprime o par para o dono cadastrar a privada como segredo e embutir a pública."""
    private_key = Ed25519PrivateKey.generate()
    private = private_key.private_bytes(
        serialization.Encoding.Raw,
        serialization.PrivateFormat.Raw,
        serialization.NoEncryption(),
    )
    public = private_key.public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw
    )
    print("Guarde a primeira linha somente no segredo protegido AGENT_SIGNING_KEY.")
    print(f"AGENT_SIGNING_KEY={base64.b64encode(private).decode('ascii')}")
    print(f"AGENT_SIGNING_PUBLIC_KEY={base64.b64encode(public).decode('ascii')}")
    return 0


def public_key() -> int:
    """Imprime só a chave pública correspondente ao segredo do ambiente."""
    secret = os.environ.get("AGENT_SIGNING_KEY", "")
    if not secret:
        print(
            "erro: o segredo AGENT_SIGNING_KEY não está disponível neste ambiente.", file=sys.stderr
        )
        return 2
    try:
        private_key = encoded_private_key(secret)
    except ValueError as exc:
        print(f"erro: {exc}", file=sys.stderr)
        return 2
    public = private_key.public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw
    )
    print(base64.b64encode(public).decode("ascii"))
    return 0


def sign(args: argparse.Namespace) -> int:
    """Assina e grava o manifesto sem registrar a chave privada em disco ou nos argumentos."""
    secret = os.environ.get("AGENT_SIGNING_KEY", "")
    if not secret:
        print(
            "erro: o segredo AGENT_SIGNING_KEY não está disponível neste ambiente.", file=sys.stderr
        )
        return 2
    try:
        private_key = encoded_private_key(secret)
    except ValueError as exc:
        print(f"erro: {exc}", file=sys.stderr)
        return 2
    fields: dict[str, str | int] = {
        "format": 1,
        "version": args.version,
        "commit": args.commit,
        "archiveSha256": args.archive_sha256,
        "archiveUrl": args.archive_url,
        "sequence": args.sequence,
    }
    signature = private_key.sign(manifest_message(fields))
    manifest = fields | {"signature": base64.b64encode(signature).decode("ascii")}
    Path(args.output).write_text(
        json.dumps(manifest, ensure_ascii=True, separators=(",", ":"), sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return 0


def embedded_keys() -> tuple[str, ...]:
    """As chaves públicas embutidas no agente deste checkout (a lista que ele aceita)."""
    from uniover_agent.adapters.self_update import MANIFEST_PUBLIC_KEYS  # noqa: PLC0415

    return tuple(MANIFEST_PUBLIC_KEYS)


def decide_activation(embedded: tuple[str, ...], secret_public: str | None) -> tuple[str, str]:
    """Decide o que o job de publicação faz: `("sign" | "skip" | "fail", mensagem)`.

    `secret_public` é a pública do segredo `AGENT_SIGNING_KEY` (`None` se ele não existe).
    Uma versão com chave embutida nunca sai sem manifesto assinado: os agentes que a instalarem
    passam a exigi-lo, e ficariam sem caminho de atualização.
    """
    if secret_public is None:
        if embedded:
            return (
                "fail",
                "o agente deste commit embute chave pública, mas AGENT_SIGNING_KEY não está"
                " cadastrado:"
                " a versão não pode sair sem manifesto assinado.",
            )
        return (
            "skip",
            "AGENT_SIGNING_KEY não está cadastrado: o Release segue sem manifesto assinado"
            " (a assinatura ainda não está ativa).",
        )
    if not embedded:
        return (
            "sign",
            "nenhuma chave pública está embutida no agente: o manifesto é anexado, mas só passa a"
            " valer na versão que embutir a chave de AGENT_SIGNING_KEY.",
        )
    if secret_public not in embedded:
        return (
            "fail",
            "a chave pública de AGENT_SIGNING_KEY não está embutida em MANIFEST_PUBLIC_KEYS.",
        )
    return "sign", ""


def activation() -> int:
    """Imprime `sign` ou `skip` (stdout) e as anotações do GitHub (stderr); falha se não puder."""
    secret = os.environ.get("AGENT_SIGNING_KEY", "")
    secret_public: str | None = None
    if secret:
        try:
            raw = (
                encoded_private_key(secret)
                .public_key()
                .public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
            )
        except ValueError as exc:
            print(f"::error::{exc}", file=sys.stderr)
            return 2
        secret_public = base64.b64encode(raw).decode("ascii")
    action, message = decide_activation(embedded_keys(), secret_public)
    if action == "fail":
        print(f"::error::{message}", file=sys.stderr)
        return 1
    if message:
        print(f"::warning::{message}", file=sys.stderr)
    print(action)
    return 0


def parser() -> argparse.ArgumentParser:
    """Declara os dois comandos locais, mantendo o segredo fora da linha de comando."""
    result = argparse.ArgumentParser(description=__doc__)
    commands = result.add_subparsers(dest="command", required=True)
    commands.add_parser("generate-key", help="gera um par Ed25519 para o segredo e a lista pública")
    commands.add_parser("public-key", help="mostra a pública correspondente ao segredo")
    commands.add_parser(
        "activation", help="decide se a publicação assina, pula ou falha (sign/skip)"
    )
    sign_parser = commands.add_parser("sign", help="assina um manifesto de Release")
    sign_parser.add_argument("--version", required=True)
    sign_parser.add_argument("--commit", required=True)
    sign_parser.add_argument("--archive-sha256", required=True)
    sign_parser.add_argument("--archive-url", required=True)
    sign_parser.add_argument("--sequence", required=True, type=int)
    sign_parser.add_argument("--output", required=True)
    return result


def main() -> int:
    """Executa o comando solicitado."""
    args = parser().parse_args()
    if args.command == "generate-key":
        return generate_key()
    if args.command == "public-key":
        return public_key()
    if args.command == "activation":
        return activation()
    return sign(args)


if __name__ == "__main__":
    raise SystemExit(main())
