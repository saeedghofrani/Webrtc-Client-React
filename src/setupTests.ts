// jest-dom adds custom jest matchers for asserting on DOM nodes.
// allows you to do things like:
// expect(element).toHaveTextContent(/react/i)
// learn more: https://github.com/testing-library/jest-dom
import '@testing-library/jest-dom';

// jsdom does not expose secure browser randomness in this Jest environment.
Object.defineProperty(globalThis, 'crypto', { configurable: true, value: require('crypto').webcrypto });
