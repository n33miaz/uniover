namespace UniOver.Modules.Tv.Domain;

/// <summary>
/// Os passos que o agente executa no TV Livre (o campo <c>action</c> de <c>tv.livre.v1</c>). Cada um é isolado e
/// reversível; o nome de cada valor é o do contrato escrito em PascalCase.
/// </summary>
internal enum TvLivreAction
{
    /// <summary>Só lê o estado.</summary>
    Status,

    /// <summary>Instala ou atualiza o launcher, sem defini-lo como padrão.</summary>
    Install,

    /// <summary>Define o launcher como tela inicial padrão, na ordem segura.</summary>
    SetHome,

    /// <summary>Voltar ao Original: devolve a tela inicial de fábrica, reativa o que foi desativado e, por padrão, desinstala.</summary>
    Restore,

    /// <summary>Grava a configuração (e a foto enviada antes) no aparelho.</summary>
    Apply,

    /// <summary>Desativa ou reativa apps (reversível).</summary>
    SetApps,

    /// <summary>Abre o Modo Dormir.</summary>
    Sleep,
}
