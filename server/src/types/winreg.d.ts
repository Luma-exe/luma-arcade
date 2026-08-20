declare module "winreg" {
  interface RegistryOptions {
    hive?: string;
    key?: string;
    host?: string;
  }

  interface RegistryItem {
    host: string;
    hive: string;
    key: string;
    name: string;
    type: string;
    value: string;
  }

  type Callback<T> = (err: Error | null, result: T) => void;

  class Registry {
    static readonly HKLM: string;
    static readonly HKCU: string;
    static readonly HKCR: string;
    static readonly HKCC: string;
    static readonly HKU: string;
    static readonly REG_SZ: string;
    static readonly REG_DWORD: string;

    constructor(options: RegistryOptions);

    get(name: string, cb: Callback<RegistryItem>): void;
    set(name: string, type: string, value: string, cb: Callback<void>): void;
    remove(name: string, cb: Callback<void>): void;
    keyExists(cb: Callback<boolean>): void;
    values(cb: Callback<RegistryItem[]>): void;
  }

  export = Registry;
}
