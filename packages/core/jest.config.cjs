/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.ts'],
  testPathIgnorePatterns: ['/node_modules/', '/dist/'],
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: {
          target: 'ESNext',
          module: 'CommonJS',
          moduleResolution: 'Node',
          esModuleInterop: true,
          types: ['node', 'jest'],
        },
      },
    ],
  },
};
