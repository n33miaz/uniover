namespace UniOver.Modules.Identity.Contracts;

public sealed record IdentityModuleInfo(string Module, string Version, IReadOnlyList<string> DependsOn);
