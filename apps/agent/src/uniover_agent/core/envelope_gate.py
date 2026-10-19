"""Portão de entrada e de saída: nada é executado nem enviado sem passar pelo esquema."""

import json
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from importlib import resources
from typing import Any

from jsonschema import Draft202012Validator, FormatChecker
from jsonschema.exceptions import ValidationError as SchemaError
from pydantic import BaseModel
from pydantic import ValidationError as ModelError
from referencing import Registry, Resource

from uniover_agent.contracts.registry import MESSAGE_MODELS
from uniover_agent.core.domain import Command

_ENVELOPE_FILE = "envelope.schema.json"
_MAX_REPORTED_PATHS = 5
_UUID_TEXT_LENGTH = 36


@dataclass(frozen=True, slots=True)
class Accepted:
    """Mensagem válida: o comando para o núcleo e o modelo tipado do contrato."""

    command: Command
    message: BaseModel


@dataclass(frozen=True, slots=True)
class Rejected:
    """Mensagem recusada. `reason` é um código estável e `detail` só traz caminhos de campo.

    Nunca carrega o corpo recebido: o que chega da rede não é confiável e pode conter segredo.
    """

    reason: str
    detail: str = ""
    message_type: str | None = None
    # `id` do envelope recusado, quando é um UUID válido: a API espera a resposta com este valor.
    reply_to: str | None = None


GateResult = Accepted | Rejected


class _Refusal(Exception):  # noqa: N818 - uso interno, vira `Rejected` na borda do portão
    def __init__(self, reason: str, detail: str = "") -> None:
        super().__init__(reason)
        self.reason = reason
        self.detail = detail


def _load_schemas() -> dict[str, Mapping[str, Any]]:
    """Lê as cópias dos esquemas empacotadas em `contracts/schemas/` (arquivo -> conteúdo)."""
    root = resources.files("uniover_agent.contracts") / "schemas"
    schemas: dict[str, Mapping[str, Any]] = {
        _ENVELOPE_FILE: json.loads((root / _ENVELOPE_FILE).read_text(encoding="utf-8"))
    }
    for entry in (root / "messages").iterdir():
        if entry.name.endswith(".schema.json"):
            schemas[entry.name] = json.loads(entry.read_text(encoding="utf-8"))
    return schemas


def _paths(error: SchemaError) -> list[str]:
    """Caminhos de campo dos erros, sem os valores: o valor recebido nunca entra no registro."""
    if error.context:
        leaves = [leaf for sub in error.context for leaf in _paths(sub)]
        if leaves:
            return leaves
    path = ".".join(str(part) for part in error.absolute_path) or "(raiz)"
    return [f"{path}: {error.validator}"]


def _describe(errors: list[SchemaError]) -> str:
    seen: list[str] = []
    for error in errors:
        for item in _paths(error):
            if item not in seen:
                seen.append(item)
    return "; ".join(seen[:_MAX_REPORTED_PATHS])


def _as_uuid(value: object) -> str | None:
    if not isinstance(value, str) or len(value) != _UUID_TEXT_LENGTH:
        return None
    try:
        return str(uuid.UUID(value))
    except ValueError:
        return None


def _location(error: SchemaError) -> list[str]:
    return [str(part) for part in error.absolute_path]


class EnvelopeGate:
    """Valida mensagens recebidas (e as que o agente monta) contra o JSON Schema do contrato.

    Os modelos pydantic gerados não reproduzem o `if/then/else` de `command.result.v1`, por isso o
    esquema é a autoridade (`jsonschema`); o modelo tipado vem depois, como segunda barreira.
    """

    def __init__(self, agent_id: str) -> None:
        self._agent_id = agent_id
        schemas = _load_schemas()
        # Os `$ref` relativos dos esquemas (`../envelope.schema.json#/...`) resolvem pelo `$id`.
        registry: Registry[Any] = Registry().with_resources(
            [(schema["$id"], Resource.from_contents(schema)) for schema in schemas.values()]
        )
        checker = FormatChecker()
        self._envelope = Draft202012Validator(
            schemas[_ENVELOPE_FILE], registry=registry, format_checker=checker
        )
        self._by_type: dict[str, Draft202012Validator] = {}
        for message_type in MESSAGE_MODELS:
            schema = schemas.get(f"{message_type}.schema.json")
            if schema is not None:
                self._by_type[message_type] = Draft202012Validator(
                    schema, registry=registry, format_checker=checker
                )

    def check_inbound(self, raw: str | bytes) -> GateResult:
        """Valida uma mensagem crua vinda da API; só `Accepted` pode chegar ao `HandleCommand`."""
        context: dict[str, str | None] = {"type": None, "reply_to": None}
        try:
            return self._inspect(raw, context)
        except _Refusal as refusal:
            return Rejected(refusal.reason, refusal.detail, context["type"], context["reply_to"])

    def _inspect(self, raw: str | bytes, context: dict[str, str | None]) -> Accepted:
        if isinstance(raw, bytes):
            raise _Refusal("quadro_binario", "só texto JSON é aceito")
        try:
            data = json.loads(raw)
        except ValueError, RecursionError:
            raise _Refusal("json_invalido") from None
        if not isinstance(data, dict):
            raise _Refusal("json_invalido", "a raiz precisa ser um objeto")

        raw_type = data.get("type")
        message_type = raw_type if isinstance(raw_type, str) else None
        context["type"] = message_type
        context["reply_to"] = _as_uuid(data.get("id"))

        if "v" in data and data["v"] != 1:
            raise _Refusal("versao_nao_suportada")
        errors = sorted(self._envelope.iter_errors(data), key=_location)
        if errors:
            raise _Refusal("fora_do_contrato", _describe(errors))
        if message_type is None or message_type not in self._by_type:
            raise _Refusal("tipo_desconhecido")
        errors = sorted(self._by_type[message_type].iter_errors(data), key=_location)
        if errors:
            raise _Refusal("fora_do_contrato", _describe(errors))
        try:
            model = MESSAGE_MODELS[message_type].model_validate(data)
        except ModelError as exc:
            paths = "; ".join(".".join(str(p) for p in e["loc"]) for e in exc.errors())
            raise _Refusal("fora_do_contrato", paths[:200]) from None

        # Só a API manda comandos, e só para este agente: impede desvio de rota ou de identidade.
        if data["source"] != "api":
            raise _Refusal("origem_invalida")
        if data["target"] != f"agent:{self._agent_id}":
            raise _Refusal("destino_invalido")

        command = Command(
            id=data["id"],
            type=message_type,
            body=data["body"],
            correlation_id=data["correlationId"],
        )
        return Accepted(command, model)

    def check_outbound(self, message: Mapping[str, Any]) -> None:
        """Valida uma mensagem do agente antes de enviar; falha aqui é erro de programação."""
        message_type = message.get("type")
        validator = self._by_type.get(message_type) if isinstance(message_type, str) else None
        if validator is None:
            raise ValueError(f"tipo de mensagem de saída desconhecido: {message_type!r}")
        errors = list(self._envelope.iter_errors(message)) + list(validator.iter_errors(message))
        if errors:
            raise ValueError(f"mensagem de saída fora do contrato: {_describe(errors)}")
