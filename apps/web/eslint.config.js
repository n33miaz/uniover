// @ts-check
const eslint = require('@eslint/js');
const { defineConfig, globalIgnores } = require('eslint/config');
const tseslint = require('typescript-eslint');
const angular = require('angular-eslint');
const boundaries = require('eslint-plugin-boundaries');

module.exports = defineConfig([
  globalIgnores([
    'dist/**',
    '.angular/**',
    'coverage/**',
    'test-results/**',
    'playwright-report/**',
  ]),
  {
    files: ['**/*.ts'],
    extends: [
      eslint.configs.recommended,
      tseslint.configs.recommended,
      tseslint.configs.stylistic,
      angular.configs.tsRecommended,
    ],
    processor: angular.processInlineTemplates,
    rules: {
      '@angular-eslint/directive-selector': [
        'error',
        { type: 'attribute', prefix: 'app', style: 'camelCase' },
      ],
      '@angular-eslint/component-selector': [
        'error',
        { type: 'element', prefix: 'app', style: 'kebab-case' },
      ],
    },
  },
  {
    // Um módulo de tela nunca importa de outro; só de core/ e shared/.
    files: ['src/app/**/*.ts'],
    plugins: { boundaries },
    settings: {
      // Sem isto os imports relativos sem extensão (`../tv/tv-page`) não são resolvidos e a regra não vê a violação.
      'import/resolver': { node: { extensions: ['.ts', '.js'] } },
      'boundaries/elements': [
        { type: 'module', pattern: 'src/app/modules/*', capture: ['name'] },
        { type: 'core', pattern: 'src/app/core' },
        { type: 'shared', pattern: 'src/app/shared' },
      ],
    },
    rules: {
      'boundaries/dependencies': [
        'error',
        {
          default: 'allow',
          policies: [
            {
              from: { element: { type: 'module' } },
              disallow: {
                to: {
                  element: {
                    type: 'module',
                    captured: { name: '!{{ from.element.captured.name }}' },
                  },
                },
              },
              message:
                'Módulo {{ from.element.captured.name }} não pode importar do módulo {{ to.element.captured.name }}: use core/ ou shared/.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/app/**/*.html'],
    extends: [angular.configs.templateRecommended, angular.configs.templateAccessibility],
    rules: {
      // Nenhum texto de tela fixo no template.
      '@angular-eslint/template/i18n': [
        'error',
        {
          checkId: false,
          checkText: true,
          checkAttributes: true,
          ignoreAttributes: [
            'aria-labelledby',
            'aria-describedby',
            'routerLink',
            'ariaCurrentWhenActive',
            'data-module',
            'stroke-linecap',
            'stroke-linejoin',
          ],
        },
      ],
    },
  },
]);
