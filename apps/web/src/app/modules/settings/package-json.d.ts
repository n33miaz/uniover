// Só o campo de versão do `package.json` é lido (a tela Sobre); o empacotador leva apenas esse campo.
declare module '*/package.json' {
  export const version: string;
}
