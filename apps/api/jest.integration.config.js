/**
 * اختبارات التكامل: تعمل على قاعدة PostgreSQL حقيقية (DATABASE_URL_TEST).
 * ملفات الاختبار في tests/integration بجذر المستودع.
 */
const path = require('path');

module.exports = {
  rootDir: '.',
  roots: [path.resolve(__dirname, '../../tests/integration')],
  testRegex: '.*\\.int-spec\\.ts$',
  moduleFileExtensions: ['ts', 'js', 'json'],
  // ملفات الاختبار خارج apps/api، لذلك نحل الحزم من node_modules الخاص بالخادم.
  modulePaths: ['<rootDir>/node_modules'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.jest.json' }],
  },
  testEnvironment: 'node',
  globalSetup: '<rootDir>/test/integration-global-setup.ts',
  setupFiles: ['<rootDir>/test/integration-env.ts'],
  testTimeout: 60000,
  maxWorkers: 1,
};
