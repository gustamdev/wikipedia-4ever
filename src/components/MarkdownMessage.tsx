import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";

// Texto do LLM é não confiável. react-markdown não usa innerHTML e ignora HTML bruto (sem rehype-raw);
// rehype-sanitize filtra o resultado; o highlight roda DEPOIS do sanitize (só acrescenta classes `hljs-*`).
const remarkPlugins = [remarkGfm];
const rehypePlugins = [rehypeSanitize, rehypeHighlight];

const components: Components = {
  // Links nunca navegam a janela: http/https abrem no navegador do sistema; o resto é inerte.
  a: ({ href, children }) => (
    <a
      href={href}
      title={href}
      onClick={(event) => {
        event.preventDefault();
        if (href && /^https?:\/\//i.test(href)) void window.electronAPI.app.openExternal(href);
      }}
    >
      {children}
    </a>
  ),
  // App offline: imagens remotas não são carregadas (a CSP também bloqueia); mostra só o texto alternativo.
  img: ({ alt }) => <span className="md__img">[imagem{alt ? `: ${alt}` : ""}]</span>,
};

export const MarkdownMessage = memo(function MarkdownMessage({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
