/** اختبارات الوحدة (لا تحتاج قاعدة بيانات). */
module.exports = {
  rootDir: '.',
  roots: ['<rootDir>/src'],
  testRegex: '.*\\.spec\\.ts$',
  moduleFileExtensions: ['ts', 'js', 'json'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.jest.json' }],
  },
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/test/unit-env.ts'],
};
