# Wikipedia 4ever

App desktop que roda LLMs **localmente** e responde perguntas com RAG sobre a Wikipedia, citando as fontes e funcionando offline depois da instalação.

**Stack:** TypeScript · Electron · React · Vite · node-llama-cpp · transformers.js (e5) · LanceDB · SQLite

> **Work in progress (WIP).** O projeto está em desenvolvimento e ainda não tem versão utilizável. A interface das etapas 8 e 9 ainda não passou por teste humano e as etapas finais (bases prontas, configurações, release) não foram feitas. Esperem mudanças incompatíveis.

## O que o projeto mostra

- **LLM local em streaming:** o processo principal do Electron carrega um modelo GGUF com `node-llama-cpp` e envia os tokens para a interface por IPC.
- **Catálogo de modelos com download resumível:** Qwen2.5 3B, Llama 3.2 3B e Phi-3.5 mini, com tamanho e SHA-256 conferidos e recomendação ✓/⚠/✕ conforme a RAM da máquina.
- **Chat com histórico:** conversas salvas em SQLite, respostas em Markdown sanitizado.
- **Embeddings locais:** `multilingual-e5-small` (384 dimensões, PT e EN) rodando em CPU.
- **Busca vetorial persistente:** índice no LanceDB, em disco, que funciona com bases maiores que a RAM.
- **Ingestão da Wikipedia:** lê os Parquets do dataset `wikimedia/wikipedia`, divide os artigos em trechos, gera os embeddings e indexa, num processo separado para não travar a interface.
- **RAG com citações:** a pergunta vira vetor, os trechos mais próximos entram no prompt dentro de um orçamento de tokens e a resposta traz as fontes. Se nada é relevante, o app diz que não encontrou, sem chamar o modelo.

## Status

| Etapa | Tema | Estado |
|---|---|---|
| 1 | Runtime do LLM local | Feita |
| 2 | Catálogo de modelos e Download Manager | Feita |
| 3 | Ciclo de vida do modelo e hardware | Feita |
| 4 | Chat com histórico em SQLite | Feita |
| 5 | Embedding Engine | Feita |
| 6 | Vector Store (LanceDB) | Feita |
| 7 | Chunker e leitura de Parquet | Feita |
| 8 | Pipeline de ingestão | Feita no código; teste da interface pendente |
| 9 | RAG Engine e citações | Feita no código; teste da interface pendente |
| 9B | Bases pré-indexadas | Planejada |
| 10 | Base de conhecimento, configurações e diagnóstico | Planejada |
| 11 | Cross-platform e performance | Planejada |
| 12 | Testes, benchmark e setup wizard | Planejada |

Gerar os embeddings no próprio computador é lento: em CPU, indexar uma Wikipedia leva de horas a dias. Por isso a etapa 9B prevê baixar uma base já indexada. Ela ainda não existe.

## Como rodar

Requisitos: Node.js recente (desenvolvido com o 26; os scripts executam TypeScript direto com `node arquivo.ts`) e npm.

```bash
git clone https://github.com/gustamdev/wikipedia-4ever.git
cd wikipedia-4ever
npm ci
npm run dev
```

O app baixa seus próprios modelos pela interface (Configurações → Modelos).

## Arquivos de desenvolvimento

Modelos e dados pesados não ficam no Git. Um comando recria tudo, com tamanho e SHA-256 conferidos, e pula o que já existe:

```bash
npm run setup:dev
```

| Arquivo | Para que serve | Tamanho |
|---|---|---|
| `dev-models/Qwen2.5-3B-Instruct-Q4_K_M.gguf` | Modelo de chat dos scripts (`rag:eval --answer`) | 1,9 GB |
| `dev-data/simple-20231101-00000.parquet` | Wikipedia Simple English, usada nos testes e na ingestão | 157 MB |
| `dev-data/pt-20231101-00002.parquet` | Um dos 6 arquivos da Wikipedia em português | 203 MB |
| `dev-data/embedding-models/` | Modelo e5 que os scripts usam como cache | ~130 MB |

Variações: `npm run setup:dev -- --only llm|data|embed` e `--dry-run`.

Para refazer o índice de teste (os primeiros ~800 artigos do `simple`) e avaliar o RAG:

```bash
npm run index:sample
npm run rag:eval -- --calibrate --vectordb dev-data/userdata/vectordb --embed-cache dev-data/embedding-models
```

## Scripts

| Comando | O que faz |
|---|---|
| `npm run dev` | Abre o app em modo de desenvolvimento |
| `npm test` | Roda os testes automáticos (`node --test`) |
| `npm run build` | Confere os tipos e gera o build |
| `npm run dist` | Empacota o app com o electron-builder |
| `npm run setup:dev` | Baixa os arquivos de desenvolvimento |
| `npm run index:sample` | Indexa um recorte do `simple` fora do Electron |
| `npm run rag:eval` | Calibra e avalia o RAG com os componentes reais |
| `npm run chunk:sample` | Mostra como o chunker divide um Parquet |
| `npm run inspect:parquet` | Inspeciona um arquivo Parquet |

## Estrutura

```
electron/   processo principal: llm, models, embeddings, vector, ingestion, rag, db, ipc
shared/     tipos compartilhados entre o processo principal e a interface
src/        interface em React (chat e configurações)
scripts/    ferramentas de desenvolvimento e avaliação
```

## Dados e licenças

- **Texto da Wikipedia:** dataset [wikimedia/wikipedia](https://huggingface.co/datasets/wikimedia/wikipedia), licenciado conforme o cartão do dataset (CC BY-SA). Trechos citados mantêm o link para o artigo original.
- **Modelos de chat:** cada um segue a própria licença. O Qwen2.5 3B usa a Qwen Research License (uso não comercial). Os termos de cada modelo estão em `electron/models/catalog.ts`.
- **Embeddings:** [Xenova/multilingual-e5-small](https://huggingface.co/Xenova/multilingual-e5-small), na revisão fixada em `electron/embeddings/embedding-engine.ts`.
- **Código:** [MIT](LICENSE).
