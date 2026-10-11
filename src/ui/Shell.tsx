import type { ReactNode } from "react";
import { Button } from "./Button";

export interface ShellProps {
  collapsed: boolean;
  view: "chat" | "settings";
  onNewChat: () => void;
  onOpenSettings: () => void;
  header: ReactNode;
  /** Conteúdo rolável da sidebar (lista de conversas). */
  sidebar: ReactNode;
  /** Fixo abaixo da área rolável (ex.: input do chat). */
  footer?: ReactNode;
  children: ReactNode;
}

/** Sidebar de conversas + área principal (layout em README → Interface). */
export function Shell({ collapsed, view, onNewChat, onOpenSettings, header, sidebar, footer, children }: ShellProps) {
  return (
    <div className="shell" data-collapsed={collapsed}>
      <aside className="sidebar" aria-label="Conversas">
        <Button block variant="primary" onClick={onNewChat}>
          + Novo chat
        </Button>
        <nav className="sidebar__list" aria-label="Lista de conversas">
          {sidebar}
        </nav>
        <div className="sidebar__footer">
          <Button block variant="ghost" aria-current={view === "settings"} onClick={onOpenSettings}>
            ⚙ Configurações
          </Button>
        </div>
      </aside>
      <main className="main">
        <header className="main__header">{header}</header>
        <div className="main__body">
          <div className="main__content">{children}</div>
        </div>
        {footer && (
          <footer className="main__footer">
            <div className="main__content">{footer}</div>
          </footer>
        )}
      </main>
    </div>
  );
}
