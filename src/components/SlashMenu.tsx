export interface SlashCommand {
  name: string;
  description: string;
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: "/new", description: "nova conversa" },
  { name: "/agent", description: "escolher o agente" },
  { name: "/model", description: "escolher o modelo" },
  { name: "/clear", description: "apagar as mensagens desta conversa" },
];

/** Comandos que casam com o texto digitado (só enquanto ele for um único `/palavra`). */
export function matchCommands(input: string): SlashCommand[] {
  if (!/^\/\S*$/.test(input)) return [];
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(input.toLowerCase()));
}

interface SlashMenuProps {
  commands: SlashCommand[];
  selected: number;
  onPick: (command: SlashCommand) => void;
}

export function SlashMenu({ commands, selected, onPick }: SlashMenuProps) {
  return (
    <ul className="slash" role="listbox" aria-label="Comandos">
      {commands.map((c, i) => (
        <li key={c.name} role="option" aria-selected={i === selected}>
          <button
            type="button"
            className="slash__item"
            tabIndex={-1}
            onMouseDown={(event) => {
              event.preventDefault(); // não tira o foco do input
              onPick(c);
            }}
          >
            <span className="slash__name">{c.name}</span>
            <span className="slash__desc">{c.description}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
