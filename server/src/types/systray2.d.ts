declare module "systray2" {
  interface MenuItem {
    title: string;
    tooltip?: string;
    checked?: boolean;
    enabled?: boolean;
  }

  interface Menu {
    icon: string;
    title?: string;
    tooltip?: string;
    items: MenuItem[];
  }

  interface SysTrayOptions {
    menu: Menu;
    debug?: boolean;
    copyDir?: boolean;
  }

  interface ClickAction {
    type: string;
    seq_id: number;
    item: MenuItem;
  }

  export default class SysTray {
    constructor(options: SysTrayOptions);
    onClick(cb: (action: ClickAction) => void): void;
    kill(exitNode?: boolean): void;
    ready(): Promise<void>;
  }
}
