import { useState } from "react";
import { matchCommands, SlashMenu, type SlashCommand } from "./SlashMenu";

interface ChatInputProps {
  busy: boolean;
  disabled: boolean;
  placeholder: string;
  onSend: (text: string) => boolean;
  onCommand: (command: SlashCommand["name"]) => void;
}

/** Enter envia, Shift+Enter quebra linha, Esc cancela a geração, `/` abre o menu de comandos. */
export function ChatInput({ busy, disabled, placeholder, onSend, onCommand }: ChatInputProps) {
  const [value, setValue] = useState("");
  const [selected, setSelected] = useState(0);
  const commands = matchCommands(value);
  const menuOpen = commands.length > 0;

  const pick = (command: SlashCommand) => {
    setValue("");
    setSelected(0);
    onCommand(command.name);
  };

  return (
    <div className="composer">
      {menuOpen && <SlashMenu commands={commands} selected={Math.min(selected, commands.length - 1)} onPick={pick} />}
      <span className="composer__prompt" aria-hidden="true">
        &gt;
      </span>
      <textarea
        className="composer__input"
        rows={2}
        aria-label="Mensagem"
        placeholder={placeholder}
        disabled={disabled}
        readOnly={busy}
        aria-busy={busy}
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          setSelected(0);
        }}
        onKeyDown={(event) => {
          if (menuOpen) {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const step = event.key === "ArrowDown" ? 1 : -1;
              setSelected((i) => (i + step + commands.length) % commands.length);
              return;
            }
            if (event.key === "Enter" || event.key === "Tab") {
              event.preventDefault();
              pick(commands[Math.min(selected, commands.length - 1)]);
              return;
            }
            if (event.key === "Escape") {
              event.preventDefault();
              setValue("");
              return;
            }
          }
          // Esc com geração em andamento: tratado pelo atalho global da tela de chat.
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            // Desabilitado enquanto gera: Enter não envia uma segunda pergunta.
            if (!busy && onSend(value)) setValue("");
          }
        }}
      />
      <span className="composer__hint">
        {busy ? "gerando… Esc cancela" : "Enter envia · Shift+Enter quebra linha · / comandos"}
      </span>
    </div>
  );
}
