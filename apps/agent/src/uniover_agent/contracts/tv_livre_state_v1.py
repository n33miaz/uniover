# GERADO por `npm --prefix contracts run generate` — não editar.
# ruff: noqa
# fmt: off

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, RootModel


class DisabledPackage(RootModel[str]):
    root: Annotated[
        str,
        Field(
            max_length=255, pattern='^[A-Za-z][A-Za-z0-9_]*([.][A-Za-z][A-Za-z0-9_]*)+$'
        ),
    ]


class TvLivreStateV1BodyAppsItem(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    package: Annotated[
        str,
        Field(
            max_length=255, pattern='^[A-Za-z][A-Za-z0-9_]*([.][A-Za-z][A-Za-z0-9_]*)+$'
        ),
    ]
    factory: Annotated[
        bool, Field(description='App de sistema que nunca foi atualizado.')
    ]
    disabled: bool


class TvLivreStateV1Body(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    requestId: UUID
    supported: Annotated[
        bool,
        Field(
            description='A TV é Android TV ou Google TV com Android 9 ou mais. Falso: o módulo some da tela.'
        ),
    ]
    sdk: Annotated[int | None, Field(ge=1, le=99)] = None
    installed: bool
    version: Annotated[
        str | None,
        Field(
            description='versionName do launcher instalado.',
            max_length=40,
            min_length=1,
        ),
    ] = None
    isHome: Annotated[
        bool, Field(description='O launcher é a tela inicial padrão agora.')
    ]
    factoryLauncher: Annotated[
        str | None,
        Field(
            description='Componente do launcher de fábrica guardado (pacote/atividade).',
            max_length=300,
            min_length=3,
        ),
    ] = None
    disabledPackages: Annotated[
        list[DisabledPackage] | None,
        Field(
            description='Pacotes que o agente desativou (e que o Voltar ao Original reativa).',
            max_length=300,
        ),
    ] = None
    apps: Annotated[list[TvLivreStateV1BodyAppsItem], Field(max_length=300)]
    at: AwareDatetime
    launcherLevel: Annotated[
        int | None,
        Field(
            description='Nível do launcher instalado (o que ele sabe fazer, não a versão). Sem o campo, o agente não soube ler (TV sem o app ou sem resposta). Só vai com a capacidade tv.livre.v2.',
            ge=1,
            le=99,
        ),
    ] = None
    applyDeferred: Annotated[
        bool | None,
        Field(
            description='Verdadeiro quando este apply só gravou a configuração porque outro app estava na frente: a tela inicial a lê sozinha na próxima vez. Só vai com a capacidade tv.livre.v2.'
        ),
    ] = None


class TvLivreStateV1Message(BaseModel):
    model_config = ConfigDict(
        extra='forbid',
    )
    v: Literal[1]
    id: UUID
    type: Literal['tv.livre.state.v1']
    source: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    target: Annotated[str, Field(pattern='^(api|agent:[a-z0-9][a-z0-9-]*)$')]
    ts: AwareDatetime
    correlationId: UUID | None
    body: Annotated[TvLivreStateV1Body, Field(title='TvLivreStateV1Body')]
