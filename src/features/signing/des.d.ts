declare module 'des.js' {
  interface DesCipher {
    update(data: ArrayLike<number>): number[];
    final(): number[];
  }
  interface DesCipherOptions {
    type: 'encrypt' | 'decrypt';
    key: ArrayLike<number>;
    iv: ArrayLike<number>;
  }
  interface DesMode {
    create(options: DesCipherOptions): DesCipher;
  }
  const des: {
    CBC: { instantiate(base: unknown): DesMode };
    EDE: unknown;
  };
  export default des;
}
