# GERADO por `npm --prefix contracts run generate` — não editar.
# ruff: noqa
# fmt: off

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, RootModel


class TvLivreV1BodyAction(
    RootModel[Literal['status', 'install', 'set-home', 'restore', 'apply', 'set-apps', 'sleep']]
):
    root: Annotated[
        Literal['status', 'install', 'set-home', 'restore', 'apply', 'set-apps', 'sleep'],
        Field(
            description='status: lê o estado. install: instala ou atualiza o launcher (não o define como padrão). set-home: define-o como padrão na ordem segura. restore: Voltar ao Original. apply: grava a configuração (configJson). set-apps: desativa ou reativa apps (reversível). sleep: abre o Modo Dormir.',
            title='TvLivreV1BodyAction',
        ),
    ]


class DisableItem(RootModel[str]):
    root: Annotated[
        str,
        Field(
            max_length=255, pattern='^[A-Za-z][A-Za-z0-9_]*([.][A-Za-z][A-Za-z0-9_]*)+$'
        ),
    ]


class EnableItem(RootModel[str]):
    root: Annotated[
        str,
        Field(
            max_length=255, pattern='^[A-Za-z][A-Za-z0-9_]*([.][A-Za-z][A-Za-z0-9_]*)+$'
        ),
    ]


class TvLivreV1Body(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    requestId: UUID
    action: Annotated[
        TvLivreV1BodyAction,
        Field(
            description='status: lê o estado. install: instala ou atualiza o launcher (não o define como padrão). set-home: define-o como padrão na ordem segura. restore: Voltar ao Original. apply: grava a configuração (configJson). set-apps: desativa ou reativa apps (reversível). sleep: abre o Modo Dormir.',
            title='TvLivreV1BodyAction',
        ),
    ]
    revision: Annotated[
        int | None,
        Field(
            description='apply: o número que só cresce (campo revision da configuração do launcher).',
            ge=0,
            le=2147483647,
        ),
    ] = None
    configJson: Annotated[
        str | None,
        Field(
            description='apply: a configuração do launcher (contracts/tv-launcher/config.v1.schema.json) sem `schema`, `revision` nem o nome da foto, que o agente acrescenta.',
            max_length=16384,
            min_length=2,
        ),
    ] = None
    photoId: UUID | None = None
    disableFactory: Annotated[
        bool | None,
        Field(
            description='set-home: depois de verificar a home nova, desativa o launcher de fábrica (reversível). Padrão: não.'
        ),
    ] = None
    uninstall: Annotated[
        bool | None,
        Field(
            description='restore: depois de voltar e verificar, desinstala o launcher. Padrão: sim.'
        ),
    ] = None
    disable: Annotated[
        list[DisableItem] | None,
        Field(
            description='set-apps: pacotes a desativar (pm disable-user). Pacotes protegidos são recusados.',
            max_length=64,
        ),
    ] = None
    enable: Annotated[
        list[EnableItem] | None,
        Field(description='set-apps: pacotes a reativar.', max_length=64),
    ] = None


class TvLivreV1Message(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    v: Literal[1]
    id: UUID
    type: Literal['tv.livre.v1']
    source: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    target: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    ts: AwareDatetime
    correlationId: UUID | None
    body: Annotated[TvLivreV1Body, Field(title='TvLivreV1Body')]
