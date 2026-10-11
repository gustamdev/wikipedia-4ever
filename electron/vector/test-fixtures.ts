// Parágrafos curtos escritos para o projeto (não copiados de nenhuma fonte), para testar a busca
// vetorial antes da Wikipedia real. `source: "test"`; `url` fictícia `test://<id>`.
import type { ChunkMetadata } from "../../shared/chunk";

export type TestTopic = "ciencia" | "historia" | "culinaria" | "esportes" | "geografia";

interface Passage {
  id: string;
  topic: TestTopic;
  language: "pt" | "en";
  title: string;
  section: string | null;
  text: string;
}

const PASSAGES: readonly Passage[] = [
  // ciência / física
  { id: "fisica-01", topic: "ciencia", language: "pt", title: "Teoria da relatividade", section: null, text: "A teoria da relatividade restrita, publicada por Albert Einstein em 1905, mostrou que o tempo e o espaço dependem do movimento do observador e que a velocidade da luz no vácuo é a mesma para todos." },
  { id: "fisica-02", topic: "ciencia", language: "pt", title: "Teoria da relatividade", section: "Relatividade geral", text: "Dez anos depois, Einstein apresentou a relatividade geral, que descreve a gravidade como a curvatura do espaço-tempo causada pela massa e pela energia." },
  { id: "fisica-03", topic: "ciencia", language: "pt", title: "Albert Einstein", section: "Vida", text: "Albert Einstein nasceu em Ulm, na Alemanha, em 1879, e trabalhou como examinador de patentes em Berna antes de se tornar professor universitário." },
  { id: "fisica-04", topic: "ciencia", language: "pt", title: "Mecânica quântica", section: null, text: "A mecânica quântica descreve o comportamento de partículas muito pequenas, como elétrons e fótons, em que a energia só pode assumir valores discretos." },
  { id: "fisica-05", topic: "ciencia", language: "pt", title: "Fotossíntese", section: null, text: "Na fotossíntese, as plantas usam a luz do sol para transformar gás carbônico e água em glicose, liberando oxigênio para a atmosfera." },
  { id: "fisica-06", topic: "ciencia", language: "pt", title: "Lâmpada incandescente", section: "Invenção", text: "Thomas Edison aperfeiçoou a lâmpada incandescente em 1879 usando um filamento de carbono que permanecia aceso por muitas horas dentro de um bulbo de vidro sem ar." },
  { id: "fisica-07", topic: "ciencia", language: "pt", title: "Leis de Newton", section: null, text: "Isaac Newton formulou três leis do movimento; a segunda afirma que a força resultante sobre um corpo é igual à sua massa multiplicada pela aceleração." },
  { id: "fisica-08", topic: "ciencia", language: "en", title: "Speed of light", section: null, text: "Light travels through a vacuum at about 299,792 kilometres per second, a constant that plays a central role in Einstein's theory of relativity." },
  { id: "fisica-09", topic: "ciencia", language: "en", title: "DNA", section: null, text: "DNA is a long molecule shaped like a double helix that stores the genetic instructions used in the growth and functioning of living organisms." },

  // história
  { id: "historia-01", topic: "historia", language: "pt", title: "Independência do Brasil", section: null, text: "A independência do Brasil foi proclamada por Dom Pedro em 7 de setembro de 1822, às margens do riacho Ipiranga, em São Paulo." },
  { id: "historia-02", topic: "historia", language: "pt", title: "Proclamação da República", section: null, text: "Em 15 de novembro de 1889, um movimento liderado por militares derrubou a monarquia e proclamou a República no Brasil." },
  { id: "historia-03", topic: "historia", language: "pt", title: "Revolução Francesa", section: null, text: "A Revolução Francesa começou em 1789 com a tomada da Bastilha e acabou com o poder absoluto do rei, espalhando ideias de liberdade e igualdade." },
  { id: "historia-04", topic: "historia", language: "pt", title: "Segunda Guerra Mundial", section: "Fim", text: "A Segunda Guerra Mundial terminou em 1945, após a rendição da Alemanha em maio e a do Japão em setembro." },
  { id: "historia-05", topic: "historia", language: "pt", title: "Império Romano", section: null, text: "O Império Romano dominou grande parte da Europa e do Mediterrâneo por séculos; sua porção ocidental caiu no ano 476." },
  { id: "historia-06", topic: "historia", language: "pt", title: "Abolição da escravatura no Brasil", section: null, text: "A Lei Áurea, assinada pela princesa Isabel em 13 de maio de 1888, aboliu oficialmente a escravidão no Brasil." },
  { id: "historia-07", topic: "historia", language: "pt", title: "Grandes navegações", section: null, text: "No século XV, navegadores portugueses e espanhóis exploraram rotas oceânicas que levaram à chegada de europeus à América e ao contorno da África." },
  { id: "historia-08", topic: "historia", language: "en", title: "Moon landing", section: null, text: "In July 1969, the Apollo 11 mission landed on the Moon, and Neil Armstrong became the first person to walk on its surface." },
  { id: "historia-09", topic: "historia", language: "en", title: "Fall of the Berlin Wall", section: null, text: "The Berlin Wall, which divided the city for almost three decades, was opened in November 1989, a symbol of the end of the Cold War." },

  // culinária
  { id: "culinaria-01", topic: "culinaria", language: "pt", title: "Bolo de chocolate", section: "Preparo", text: "Para um bolo de chocolate simples, misture farinha, açúcar, ovos, leite e chocolate em pó, e asse em forno médio por cerca de quarenta minutos." },
  { id: "culinaria-02", topic: "culinaria", language: "pt", title: "Feijoada", section: null, text: "A feijoada é um prato brasileiro feito com feijão-preto cozido lentamente com carnes de porco e servido com arroz, couve e laranja." },
  { id: "culinaria-03", topic: "culinaria", language: "pt", title: "Pão de queijo", section: null, text: "O pão de queijo, típico de Minas Gerais, é feito com polvilho, ovos, leite e queijo curado, e fica crocante por fora e macio por dentro." },
  { id: "culinaria-04", topic: "culinaria", language: "pt", title: "Arroz", section: "Cozimento", text: "Para cozinhar arroz soltinho, refogue os grãos no óleo com alho antes de adicionar a água fervente e deixe secar em fogo baixo com a panela tampada." },
  { id: "culinaria-05", topic: "culinaria", language: "pt", title: "Brigadeiro", section: null, text: "O brigadeiro é um doce feito com leite condensado, manteiga e chocolate, mexidos no fogo até desgrudar da panela e enrolados em bolinhas." },
  { id: "culinaria-06", topic: "culinaria", language: "pt", title: "Moqueca", section: null, text: "A moqueca baiana leva peixe, leite de coco, azeite de dendê, pimentões e coentro, cozidos juntos em uma panela de barro." },
  { id: "culinaria-07", topic: "culinaria", language: "en", title: "Pizza dough", section: null, text: "Pizza dough is made from flour, water, yeast and salt, kneaded until smooth and left to rise before being stretched and baked in a very hot oven." },
  { id: "culinaria-08", topic: "culinaria", language: "en", title: "Sushi", section: null, text: "Sushi combines vinegared rice with ingredients such as raw fish, seaweed and vegetables, and is a traditional dish of Japanese cuisine." },

  // esportes
  { id: "esportes-01", topic: "esportes", language: "pt", title: "Seleção Brasileira de Futebol", section: "Títulos", text: "A seleção brasileira de futebol é a maior vencedora da Copa do Mundo, com cinco títulos: 1958, 1962, 1970, 1994 e 2002." },
  { id: "esportes-02", topic: "esportes", language: "pt", title: "Pelé", section: null, text: "Pelé, apelido de Edson Arantes do Nascimento, é considerado um dos maiores jogadores de futebol da história e venceu três Copas do Mundo." },
  { id: "esportes-03", topic: "esportes", language: "pt", title: "Fórmula 1", section: "Pilotos brasileiros", text: "Ayrton Senna foi tricampeão mundial de Fórmula 1 e é lembrado pela habilidade em pista molhada e pelas vitórias no Grande Prêmio de Mônaco." },
  { id: "esportes-04", topic: "esportes", language: "pt", title: "Jogos Olímpicos", section: null, text: "Os Jogos Olímpicos modernos acontecem a cada quatro anos e reúnem atletas de quase todos os países em dezenas de modalidades." },
  { id: "esportes-05", topic: "esportes", language: "pt", title: "Voleibol", section: null, text: "No voleibol, duas equipes de seis jogadores tentam fazer a bola tocar o chão da quadra adversária passando-a por cima de uma rede." },
  { id: "esportes-06", topic: "esportes", language: "pt", title: "Maratona", section: null, text: "A maratona é uma corrida de rua com 42,195 quilômetros, distância inspirada na lenda do mensageiro grego que correu de Maratona a Atenas." },
  { id: "esportes-07", topic: "esportes", language: "en", title: "Tennis", section: null, text: "Tennis matches are played on grass, clay or hard courts, and the four Grand Slam tournaments are the most prestigious events of the season." },
  { id: "esportes-08", topic: "esportes", language: "en", title: "Basketball", section: null, text: "Basketball was invented in 1891 by James Naismith, who nailed peach baskets to the walls of a gym as the first goals." },

  // geografia
  { id: "geografia-01", topic: "geografia", language: "pt", title: "Paris", section: null, text: "Paris é a capital e a cidade mais populosa da França, atravessada pelo rio Sena e conhecida pela Torre Eiffel e pelo Museu do Louvre." },
  { id: "geografia-02", topic: "geografia", language: "pt", title: "Rio Amazonas", section: null, text: "O rio Amazonas atravessa o norte da América do Sul e é o maior rio do mundo em volume de água, despejando uma enorme vazão no oceano Atlântico." },
  { id: "geografia-03", topic: "geografia", language: "pt", title: "Brasília", section: null, text: "Brasília foi inaugurada em 1960 para ser a nova capital do Brasil e tem um plano urbano em forma de avião desenhado por Lúcio Costa." },
  { id: "geografia-04", topic: "geografia", language: "pt", title: "Monte Everest", section: null, text: "O monte Everest, na cordilheira do Himalaia, é a montanha mais alta do planeta, com cerca de 8.849 metros acima do nível do mar." },
  { id: "geografia-05", topic: "geografia", language: "pt", title: "Deserto do Saara", section: null, text: "O Saara, no norte da África, é o maior deserto quente do mundo, com dunas de areia, planaltos rochosos e chuvas muito raras." },
  { id: "geografia-06", topic: "geografia", language: "pt", title: "Japão", section: null, text: "O Japão é um arquipélago no leste da Ásia formado por quatro ilhas principais, e sua capital é Tóquio." },
  { id: "geografia-07", topic: "geografia", language: "en", title: "Pacific Ocean", section: null, text: "The Pacific is the largest and deepest of Earth's oceans, stretching from the Arctic in the north to the Southern Ocean in the south." },
  { id: "geografia-08", topic: "geografia", language: "en", title: "Canada", section: null, text: "Canada is the second-largest country in the world by area, and its capital city is Ottawa, located in the province of Ontario." },
];

export const TEST_DATASET_VERSION = "w4e-test-1";

/** Chunks de teste (sem vetor); `topic` fica fora do schema e serve só para verificar a busca. */
export function testChunks(): Array<ChunkMetadata & { topic: TestTopic }> {
  return PASSAGES.map((p) => ({
    chunk_id: `test:${p.language}:${p.id}:0000`,
    document_id: p.id,
    document_title: p.title,
    section: p.section,
    text: p.text,
    language: p.language,
    source: "test",
    dataset_version: TEST_DATASET_VERSION,
    url: `test://${p.id}`,
    topic: p.topic,
  }));
}

/** Perguntas do critério 2 (Semana 6): o top-5 deve ser majoritariamente do tema esperado. */
export const TEST_QUERIES: ReadonlyArray<{ query: string; topic: TestTopic }> = [
  { query: "Como surgiu a teoria da relatividade?", topic: "ciencia" },
  { query: "Quando o Brasil deixou de ser uma monarquia?", topic: "historia" },
  { query: "Como fazer um doce com chocolate?", topic: "culinaria" },
  { query: "Quantas Copas do Mundo o Brasil ganhou?", topic: "esportes" },
  { query: "Qual é a montanha mais alta do mundo?", topic: "geografia" },
];
