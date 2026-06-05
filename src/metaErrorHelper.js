// src/metaErrorHelper.js
// Camada de tradução dos erros da Meta/WhatsApp Cloud API para mensagens operacionais.
// Mantém o retorno técnico em separado, mas entrega causa provável e próxima ação para o painel.

function digitsOnly(value) {
  return String(value == null ? "" : value).replace(/\D+/g, "");
}

function pickMetaError(input) {
  if (!input) return null;
  if (input.metaError && typeof input.metaError === "object") return input.metaError;
  if (input.error && typeof input.error === "object") return input.error;
  if (input.payload && typeof input.payload === "object" && input.payload.error) return input.payload.error;
  if (input.details && typeof input.details === "object" && input.details.error) return input.details.error;
  if (typeof input === "object" && (input.code || input.message || input.error_user_msg || input.error_user_title)) return input;
  return null;
}

const META_ERROR_MAP = {
  0: {
    title: "Falha de autenticação ou permissão",
    category: "Autenticação",
    severity: "error",
    retryable: false,
    cause: "A Meta recusou a requisição por falta de autenticação, permissão ou acesso ao recurso.",
    action: "Revise o token, as permissões do aplicativo e se o usuário/sistema tem acesso ao WABA e ao número.",
    nextSteps: ["Refazer o vínculo com a Meta", "Conferir permissões whatsapp_business_messaging e whatsapp_business_management", "Validar se o token pertence ao mesmo WABA do número"],
  },
  1: {
    title: "Erro desconhecido da API da Meta",
    category: "Meta/Serviço",
    severity: "warning",
    retryable: true,
    cause: "A Meta retornou um erro genérico ou temporário.",
    action: "Tente novamente. Se persistir, salve o retorno técnico e abra investigação com a Meta.",
    nextSteps: ["Tentar novamente em alguns minutos", "Verificar status da plataforma", "Enviar o retorno técnico para o desenvolvedor"],
  },
  2: {
    title: "Serviço da Meta temporariamente indisponível",
    category: "Meta/Serviço",
    severity: "warning",
    retryable: true,
    cause: "A plataforma pode estar instável, em manutenção ou sobrecarregada.",
    action: "Aguarde e tente novamente. Não altere campanha, token ou modelo antes de confirmar se é instabilidade.",
    nextSteps: ["Aguardar alguns minutos", "Reduzir tentativas repetidas", "Verificar o status da WhatsApp Business Platform"],
  },
  4: {
    title: "Limite de chamadas da API atingido",
    category: "Limite",
    severity: "warning",
    retryable: true,
    cause: "O aplicativo fez chamadas demais à API em um curto período.",
    action: "Diminua a frequência de chamadas e implemente espera entre novas tentativas.",
    nextSteps: ["Aumentar o intervalo entre envios", "Evitar atualizar modelos/status em loop", "Tentar novamente mais tarde"],
  },
  10: {
    title: "Permissão negada pela Meta",
    category: "Permissão",
    severity: "error",
    retryable: false,
    cause: "O token ou aplicativo não tem permissão para executar esta ação.",
    action: "Refaça o vínculo com a Meta e confirme as permissões do app e do usuário.",
    nextSteps: ["Conferir permissões no App da Meta", "Confirmar acesso ao Business Manager", "Gerar novo token/vínculo"],
  },
  33: {
    title: "Número remetente removido ou inválido",
    category: "Conta/Registro",
    severity: "error",
    retryable: false,
    cause: "O Phone Number ID usado pode ter sido removido, estar errado ou não existir mais no WABA.",
    action: "Confirme o Phone Number ID salvo no painel e refaça a conexão com o número correto.",
    nextSteps: ["Abrir WhatsApp Manager", "Confirmar o ID do número", "Refazer vínculo no painel"],
  },
  100: {
    title: "Parâmetro inválido na requisição",
    category: "Configuração",
    severity: "error",
    retryable: false,
    cause: "Algum campo enviado para a Meta está ausente, inválido ou fora do formato esperado.",
    action: "Revise modelo, idioma, variáveis, telefone, mídia e estrutura enviada.",
    nextSteps: ["Conferir o retorno técnico", "Validar variáveis do modelo", "Testar com um único contato"],
  },
  190: {
    title: "Token expirado ou inválido",
    category: "Autenticação",
    severity: "error",
    retryable: false,
    cause: "O token salvo foi recusado pela Meta, expirou ou perdeu permissão.",
    action: "Refaça o vínculo do WhatsApp no painel para salvar um novo token.",
    nextSteps: ["Desconectar e conectar novamente", "Confirmar permissões do app", "Testar listagem de modelos"],
  },
  200: {
    title: "Permissões insuficientes",
    category: "Permissão",
    severity: "error",
    retryable: false,
    cause: "A conta autenticada não tem acesso suficiente ao ativo solicitado.",
    action: "Garanta acesso ao WABA, ao número e às permissões necessárias no Business Manager.",
    nextSteps: ["Verificar permissões do usuário", "Verificar permissões do app", "Refazer vínculo"],
  },
  368: {
    title: "Conta restringida por política",
    category: "Política",
    severity: "error",
    retryable: false,
    cause: "A conta ou app pode estar temporariamente bloqueado por violação de política.",
    action: "Verifique a Qualidade da Conta e possíveis restrições no Business Manager antes de novos disparos.",
    nextSteps: ["Abrir Qualidade da Conta", "Revisar políticas e mensagens", "Solicitar análise se houver bloqueio"],
  },
  80007: {
    title: "Limite de taxa da conta atingido",
    category: "Limite",
    severity: "warning",
    retryable: true,
    cause: "A conta atingiu limite de chamadas ou operações.",
    action: "Reduza o volume momentaneamente e tente novamente mais tarde.",
    nextSteps: ["Aumentar throttle", "Evitar disparos paralelos", "Retomar depois"],
  },
  130429: {
    title: "Limite de envio por segundo atingido",
    category: "Limite",
    severity: "warning",
    retryable: true,
    cause: "O throughput do número foi excedido. Foram enviados muitos disparos por segundo.",
    action: "Aumente o intervalo entre envios e divida campanhas grandes em lotes menores.",
    nextSteps: ["Aumentar throttle para 1000ms ou mais", "Quebrar a base em lotes", "Retomar após alguns minutos"],
  },
  130472: {
    title: "Número do usuário em experimento da Meta",
    category: "Entrega",
    severity: "warning",
    retryable: false,
    cause: "A Meta não entregou a mensagem por regra/experimento de marketing aplicado ao destinatário.",
    action: "Não insista no envio imediato para esse contato. Tente outro canal ou aguarde.",
    nextSteps: ["Marcar contato como não entregue", "Tentar outro canal", "Reavaliar em outra campanha"],
  },
  130497: {
    title: "Restrição de envio para o país do destinatário",
    category: "Política/País",
    severity: "error",
    retryable: false,
    cause: "A conta não pode enviar mensagens para usuários de determinados países.",
    action: "Confira país, política do negócio e elegibilidade da conta no WhatsApp Manager.",
    nextSteps: ["Validar DDI do contato", "Conferir restrições da conta", "Não reenviar sem revisar política"],
  },
  131000: {
    title: "Erro genérico no envio",
    category: "Meta/Serviço",
    severity: "warning",
    retryable: true,
    cause: "A Meta recusou o envio por motivo genérico ou temporário.",
    action: "Tente novamente com poucos contatos e revise o retorno técnico se persistir.",
    nextSteps: ["Testar com um contato", "Revisar payload técnico", "Tentar novamente depois"],
  },
  131005: {
    title: "Acesso negado ao recurso",
    category: "Permissão",
    severity: "error",
    retryable: false,
    cause: "O token não tem acesso ao recurso solicitado.",
    action: "Refaça a conexão e confirme se o número pertence ao WABA conectado.",
    nextSteps: ["Conferir WABA ID", "Conferir Phone Number ID", "Refazer vínculo"],
  },
  131008: {
    title: "Parâmetro obrigatório ausente",
    category: "Configuração",
    severity: "error",
    retryable: false,
    cause: "A requisição enviada está faltando algum campo obrigatório.",
    action: "Revise campos do modelo, idioma, variáveis, telefone e mídia.",
    nextSteps: ["Ver retorno técnico", "Corrigir payload", "Testar novamente"],
  },
  131009: {
    title: "Valor de parâmetro inválido",
    category: "Configuração",
    severity: "error",
    retryable: false,
    cause: "Um campo existe, mas está com valor inválido para a Meta.",
    action: "Revise variáveis, telefone no formato E.164, template e idioma.",
    nextSteps: ["Validar número com DDI", "Conferir idioma do modelo", "Conferir quantidade de variáveis"],
  },
  131016: {
    title: "Serviço temporariamente indisponível",
    category: "Meta/Serviço",
    severity: "warning",
    retryable: true,
    cause: "Algum serviço da WhatsApp Business Platform está temporariamente indisponível.",
    action: "Aguarde e tente novamente. Evite reenviar em massa imediatamente.",
    nextSteps: ["Aguardar", "Ver status da plataforma", "Reprocessar somente falhas depois"],
  },
  131021: {
    title: "Destinatário igual ao remetente",
    category: "Contato",
    severity: "error",
    retryable: false,
    cause: "O número que está enviando é o mesmo número do destinatário.",
    action: "Use um número de teste diferente do número oficial da API.",
    nextSteps: ["Remover esse contato da base", "Testar com outro número", "Validar base antes do envio"],
  },
  131026: {
    title: "Mensagem não pôde ser entregue ao contato",
    category: "Contato/Entrega",
    severity: "warning",
    retryable: false,
    cause: "O número pode não ter WhatsApp, pode estar incorreto, ter bloqueado a empresa, não ter aceitado termos recentes ou estar indisponível para esse tipo de mensagem.",
    action: "Não trate como problema da campanha inteira. Separe esses contatos e valide por outro canal.",
    nextSteps: ["Conferir DDI/DDD e número", "Testar contato manualmente", "Remover ou marcar como sem entrega", "Evitar reenviar em sequência"],
  },
  131031: {
    title: "Conta WhatsApp bloqueada ou travada",
    category: "Conta/Política",
    severity: "error",
    retryable: false,
    cause: "A conta pode estar bloqueada, restringida ou com informação de verificação incorreta.",
    action: "Abra o WhatsApp Manager e Qualidade da Conta para resolver bloqueios antes de novos envios.",
    nextSteps: ["Verificar Qualidade da Conta", "Conferir PIN/verificação", "Solicitar revisão se necessário"],
  },
  131037: {
    title: "Nome de exibição ainda não aprovado",
    category: "Conta/Registro",
    severity: "error",
    retryable: false,
    cause: "O número oficial ainda não tem nome de exibição aprovado para enviar mensagens.",
    action: "Aguarde/aprove o nome de exibição no WhatsApp Manager.",
    nextSteps: ["Verificar status do display name", "Ajustar nome se recusado", "Reenviar após aprovação"],
  },
  131042: {
    title: "Problema de pagamento ou elegibilidade",
    category: "Pagamento",
    severity: "error",
    retryable: false,
    cause: "A conta pode estar sem forma de pagamento, com limite excedido, linha de crédito inativa ou suspensa.",
    action: "Corrija cobrança/pagamento no Business Manager antes de enviar novas campanhas.",
    nextSteps: ["Verificar cobrança", "Confirmar método de pagamento", "Conferir limite/linha de crédito"],
  },
  131045: {
    title: "Erro de registro/certificado do número",
    category: "Conta/Registro",
    severity: "error",
    retryable: false,
    cause: "O número remetente não foi registrado corretamente ou há problema de certificado/registro.",
    action: "Registre novamente o número ou refaça a conexão do WhatsApp oficial.",
    nextSteps: ["Verificar status do número", "Refazer registro", "Refazer vínculo no painel"],
  },
  131047: {
    title: "Janela de 24 horas encerrada",
    category: "Conversação",
    severity: "warning",
    retryable: false,
    cause: "Você tentou enviar mensagem livre fora da janela de atendimento de 24h.",
    action: "Use um modelo aprovado para reabrir a conversa.",
    nextSteps: ["Enviar template aprovado", "Evitar texto livre fora da janela", "Aguardar interação do usuário"],
  },
  131048: {
    title: "Limite por qualidade/spam atingido",
    category: "Qualidade",
    severity: "warning",
    retryable: true,
    cause: "A Meta restringiu o volume por sinais de bloqueio, denúncia ou baixa qualidade.",
    action: "Reduza frequência, melhore segmentação e revise a qualidade dos modelos.",
    nextSteps: ["Pausar ou reduzir volume", "Verificar qualidade do número", "Revisar copy e base", "Evitar disparo frio agressivo"],
  },
  131049: {
    title: "Limite saudável de mensagens de marketing",
    category: "Qualidade/Marketing",
    severity: "warning",
    retryable: false,
    cause: "A Meta evitou entregar marketing para esse usuário para preservar engajamento saudável.",
    action: "Não tente reenviar imediatamente para o mesmo contato. Aguarde e use outro canal se necessário.",
    nextSteps: ["Aguardar pelo menos 24h", "Não reprocessar em loop", "Melhorar segmentação"],
  },
  131050: {
    title: "Contato optou por não receber marketing",
    category: "Contato/Opt-out",
    severity: "warning",
    retryable: false,
    cause: "O destinatário escolheu parar de receber mensagens de marketing da empresa.",
    action: "Remova esse contato de campanhas de marketing pelo WhatsApp.",
    nextSteps: ["Marcar opt-out", "Não reenviar marketing", "Usar apenas canal permitido quando houver base legal"],
  },
  131051: {
    title: "Tipo de mensagem não suportado",
    category: "Configuração",
    severity: "error",
    retryable: false,
    cause: "O formato da mensagem, botão ou mídia não é suportado nesse envio.",
    action: "Use modelos aprovados e tipos de mídia aceitos pela Cloud API.",
    nextSteps: ["Conferir tipo de mídia", "Conferir botões do template", "Usar modelo aprovado"],
  },
  131052: {
    title: "Falha ao baixar mídia recebida",
    category: "Mídia",
    severity: "warning",
    retryable: true,
    cause: "A Meta não conseguiu disponibilizar a mídia enviada pelo usuário.",
    action: "Peça o arquivo novamente ou use outro canal para receber a mídia.",
    nextSteps: ["Solicitar reenvio", "Tentar novamente depois", "Usar link/arquivo externo"],
  },
  131053: {
    title: "Falha ao enviar mídia",
    category: "Mídia",
    severity: "error",
    retryable: false,
    cause: "A mídia enviada pode estar em formato, tamanho ou URL inválidos.",
    action: "Revise formato, tamanho, mimetype e acesso público ao arquivo.",
    nextSteps: ["Validar tipo e tamanho", "Testar URL/arquivo", "Enviar mídia compatível"],
  },
  131055: {
    title: "Tipo de template não permitido nesta API",
    category: "Modelo",
    severity: "error",
    retryable: false,
    cause: "A ação exige modelo de categoria/tipo específico, geralmente marketing.",
    action: "Use um template de marketing aprovado quando estiver usando API de marketing/disparo.",
    nextSteps: ["Conferir categoria do modelo", "Criar modelo correto", "Aguardar aprovação"],
  },
  131056: {
    title: "Limite de mensagens para o mesmo contato",
    category: "Limite/Contato",
    severity: "warning",
    retryable: true,
    cause: "Foram enviadas muitas mensagens do mesmo remetente para o mesmo destinatário em pouco tempo.",
    action: "Aguarde antes de falar novamente com esse contato.",
    nextSteps: ["Não reenviar agora", "Aguardar", "Revisar automações duplicadas"],
  },
  131057: {
    title: "Conta em modo de manutenção",
    category: "Conta/Manutenção",
    severity: "warning",
    retryable: true,
    cause: "A conta ou número pode estar em manutenção, atualização ou ajuste de throughput.",
    action: "Aguarde e tente novamente mais tarde.",
    nextSteps: ["Aguardar alguns minutos", "Verificar status no WhatsApp Manager", "Retomar campanha depois"],
  },
  132000: {
    title: "Quantidade de variáveis incompatível",
    category: "Modelo",
    severity: "error",
    retryable: false,
    cause: "O número de parâmetros enviados não bate com as variáveis do modelo aprovado.",
    action: "Ajuste as variáveis do envio para corresponder exatamente ao modelo.",
    nextSteps: ["Conferir {{1}}, {{2}}, etc.", "Mapear colunas da planilha", "Testar com um contato"],
  },
  132001: {
    title: "Modelo não existe ou idioma incorreto",
    category: "Modelo",
    severity: "error",
    retryable: false,
    cause: "O template informado não existe no WABA, não está aprovado ou foi chamado com idioma diferente.",
    action: "Atualize a lista de modelos, escolha um aprovado e confirme o idioma.",
    nextSteps: ["Clicar em atualizar modelos", "Escolher status APPROVED", "Conferir language code, ex: pt_BR"],
  },
  132005: {
    title: "Template traduzido com tamanho inválido",
    category: "Modelo",
    severity: "error",
    retryable: false,
    cause: "A tradução ou conteúdo do modelo ficou maior do que o permitido.",
    action: "Edite/crie outro modelo com texto menor.",
    nextSteps: ["Reduzir texto", "Enviar novo modelo", "Aguardar aprovação"],
  },
  132007: {
    title: "Conteúdo do modelo viola política ou formato",
    category: "Modelo/Política",
    severity: "error",
    retryable: false,
    cause: "A Meta rejeitou conteúdo, formato ou caracteres do modelo.",
    action: "Reescreva o modelo com linguagem mais clara, menos agressiva e dentro das políticas.",
    nextSteps: ["Revisar copy", "Evitar promessas sensíveis", "Criar novo template"],
  },
  132012: {
    title: "Parâmetros do modelo inválidos",
    category: "Modelo",
    severity: "error",
    retryable: false,
    cause: "As variáveis enviadas não combinam com o formato esperado pelo template.",
    action: "Confira ordem, quantidade e tipo das variáveis do modelo.",
    nextSteps: ["Conferir colunas da planilha", "Preencher variáveis vazias", "Testar com uma linha"],
  },
  132015: {
    title: "Modelo pausado pela Meta",
    category: "Modelo/Qualidade",
    severity: "warning",
    retryable: false,
    cause: "O modelo foi pausado, normalmente por baixa qualidade ou feedback negativo.",
    action: "Não use esse template agora. Crie uma variação melhor ou aguarde a liberação.",
    nextSteps: ["Escolher outro template", "Revisar conteúdo", "Melhorar segmentação"],
  },
  132016: {
    title: "Modelo desativado",
    category: "Modelo/Qualidade",
    severity: "error",
    retryable: false,
    cause: "O template foi desativado e não pode mais ser usado.",
    action: "Crie um novo modelo com conteúdo revisado e aguarde aprovação.",
    nextSteps: ["Criar novo template", "Evitar texto repetitivo/agressivo", "Aguardar aprovação"],
  },
  132068: {
    title: "Flow bloqueado",
    category: "Flow",
    severity: "error",
    retryable: false,
    cause: "O fluxo usado na mensagem está bloqueado ou indisponível.",
    action: "Revise o status do Flow na Meta antes de enviar novamente.",
    nextSteps: ["Abrir Flow Manager", "Corrigir/publicar flow", "Testar novamente"],
  },
  132069: {
    title: "Flow limitado pela Meta",
    category: "Flow/Limite",
    severity: "warning",
    retryable: true,
    cause: "O fluxo atingiu limite ou foi temporariamente restringido.",
    action: "Aguarde, reduza volume e revise o Flow.",
    nextSteps: ["Reduzir volume", "Aguardar", "Testar depois"],
  },
  133000: {
    title: "Desregistro incompleto do número",
    category: "Conta/Registro",
    severity: "error",
    retryable: false,
    cause: "Uma tentativa anterior de remover/desregistrar o número não foi concluída.",
    action: "Conclua o desregistro antes de registrar novamente.",
    nextSteps: ["Finalizar desregistro", "Registrar o número novamente", "Refazer vínculo"],
  },
  133004: {
    title: "Servidor de registro temporariamente indisponível",
    category: "Meta/Serviço",
    severity: "warning",
    retryable: true,
    cause: "A Meta não conseguiu processar registro/desregistro no momento.",
    action: "Aguarde e tente novamente.",
    nextSteps: ["Aguardar", "Evitar múltiplas tentativas", "Verificar status da plataforma"],
  },
  133005: {
    title: "PIN de verificação em duas etapas incorreto",
    category: "Conta/Registro",
    severity: "error",
    retryable: false,
    cause: "O PIN informado não corresponde ao PIN configurado para o número.",
    action: "Use o PIN correto ou redefina a verificação em duas etapas no WhatsApp Manager.",
    nextSteps: ["Conferir PIN", "Redefinir se necessário", "Registrar novamente"],
  },
  133006: {
    title: "Número precisa ser verificado antes do registro",
    category: "Conta/Registro",
    severity: "error",
    retryable: false,
    cause: "O número ainda precisa passar pela verificação para poder ser registrado.",
    action: "Verifique o número e depois registre na Cloud API.",
    nextSteps: ["Fazer verificação do número", "Confirmar código/PIN", "Registrar novamente"],
  },
  133008: {
    title: "Muitas tentativas de PIN",
    category: "Conta/Registro",
    severity: "warning",
    retryable: true,
    cause: "Foram feitas muitas tentativas de PIN para esse número.",
    action: "Aguarde o prazo indicado pela Meta antes de tentar novamente.",
    nextSteps: ["Não tentar em sequência", "Aguardar desbloqueio", "Usar PIN correto"],
  },
  133009: {
    title: "PIN informado rápido demais",
    category: "Conta/Registro",
    severity: "warning",
    retryable: true,
    cause: "A Meta bloqueou temporariamente por tentativas muito rápidas de PIN.",
    action: "Aguarde antes de tentar novamente.",
    nextSteps: ["Esperar o prazo", "Evitar automação repetindo PIN", "Tentar manualmente depois"],
  },
  133010: {
    title: "Número remetente não registrado na Cloud API",
    category: "Conta/Registro",
    severity: "error",
    retryable: false,
    cause: "O número oficial usado como remetente não está registrado corretamente na WhatsApp Business Platform/Cloud API. Isso normalmente não é erro do lead.",
    action: "Registre o número da empresa na Cloud API ou refaça o vínculo do WhatsApp oficial no painel com o WABA e Phone Number ID corretos.",
    nextSteps: ["Abrir WhatsApp Manager e conferir se o número está conectado/registrado", "Se estiver pendente, registrar o número pela API /register", "Confirmar se o Phone Number ID salvo é o número correto", "Refazer o vínculo do WhatsApp oficial no painel"],
  },
  133015: {
    title: "Número removido recentemente",
    category: "Conta/Registro",
    severity: "warning",
    retryable: true,
    cause: "O número foi deletado recentemente e a exclusão ainda não finalizou.",
    action: "Aguarde alguns minutos antes de registrar novamente.",
    nextSteps: ["Aguardar pelo menos 5 minutos", "Tentar registrar novamente", "Evitar tentativas em loop"],
  },
  133016: {
    title: "Limite de registro/desregistro excedido",
    category: "Conta/Registro",
    severity: "warning",
    retryable: true,
    cause: "Foram feitas muitas tentativas de registrar ou remover esse número em pouco tempo.",
    action: "Aguarde o desbloqueio antes de tentar novamente.",
    nextSteps: ["Pausar tentativas", "Aguardar prazo da Meta", "Revisar fluxo de registro antes de tentar"],
  },
  134011: {
    title: "Termos do WhatsApp Payments pendentes",
    category: "Pagamento",
    severity: "warning",
    retryable: false,
    cause: "A conta precisa aceitar termos relacionados a pagamentos.",
    action: "Aceite os termos indicados pela Meta antes de tentar novamente.",
    nextSteps: ["Abrir aviso da Meta", "Aceitar termos pendentes", "Repetir envio"],
  },
  135000: {
    title: "Erro genérico de usuário/configuração",
    category: "Configuração",
    severity: "warning",
    retryable: false,
    cause: "A Meta retornou um erro genérico, muitas vezes ligado a migração, webhook ou configuração da conta.",
    action: "Revise configuração do número, webhooks, templates e vínculo com o WABA.",
    nextSteps: ["Conferir webhooks", "Testar token e WABA", "Criar novo template se necessário", "Enviar retorno técnico ao dev"],
  },
  2388103: {
    title: "Conta WhatsApp não configurada corretamente",
    category: "Conta/Registro",
    severity: "error",
    retryable: false,
    cause: "A conta/número do WhatsApp Business precisa estar aprovada e configurada corretamente.",
    action: "Finalize a configuração e aprovação do WABA/número antes do envio.",
    nextSteps: ["Verificar aprovação do WABA", "Verificar status do número", "Refazer conexão se necessário"],
  },
  2494100: {
    title: "Número em modo de manutenção",
    category: "Conta/Manutenção",
    severity: "warning",
    retryable: true,
    cause: "O número comercial está temporariamente em manutenção.",
    action: "Aguarde alguns minutos e tente novamente.",
    nextSteps: ["Aguardar", "Retomar depois", "Evitar várias tentativas"],
  },
};

function inferByMessage(message) {
  const msg = String(message || "").toLowerCase();
  if (!msg) return null;
  if (/account.*not.*registered|not registered|account not registered/.test(msg)) return META_ERROR_MAP[133010];
  if (/access token|oauth|token.*expired|invalid.*token|session/.test(msg)) return META_ERROR_MAP[190];
  if (/permission|permissions|not authorized|access denied/.test(msg)) return META_ERROR_MAP[200];
  if (/template.*not.*exist|does not exist.*template|template.*missing/.test(msg)) return META_ERROR_MAP[132001];
  if (/parameter|param|invalid value|missing required/.test(msg)) return META_ERROR_MAP[100];
  if (/rate limit|too many|throughput|calls/.test(msg)) return META_ERROR_MAP[130429];
  if (/undeliverable|unable to deliver|could not be delivered/.test(msg)) return META_ERROR_MAP[131026];
  if (/payment|billing|credit/.test(msg)) return META_ERROR_MAP[131042];
  if (/policy|restricted|disabled|blocked/.test(msg)) return META_ERROR_MAP[368];
  return null;
}

function normalizeMetaError(input, options = {}) {
  const meta = pickMetaError(input);
  const rawMessage = String(
    (meta && (meta.error_user_msg || meta.message || meta.title || meta.error_user_title)) ||
    (input && input.message) ||
    (typeof input === "string" ? input : "") ||
    "Erro retornado pela Meta."
  );
  const code = meta && meta.code !== undefined && meta.code !== null ? Number(meta.code) : null;
  const subcode = meta && meta.error_subcode !== undefined && meta.error_subcode !== null ? Number(meta.error_subcode) : null;
  const mapped = (Number.isFinite(code) && META_ERROR_MAP[code]) || inferByMessage(rawMessage) || null;
  const fallback = {
    title: Number.isFinite(code) ? `Erro Meta ${code}` : "Erro retornado pela Meta",
    category: "Não mapeado",
    severity: "warning",
    retryable: Boolean(meta && meta.is_transient),
    cause: "A Meta retornou um erro que ainda não possui tradução específica no painel.",
    action: "Abra os detalhes técnicos e envie para o desenvolvedor analisar o código e o payload completo.",
    nextSteps: ["Ver retorno técnico", "Testar com um contato", "Enviar código e payload para o desenvolvedor"],
  };
  const info = mapped || fallback;
  const userTitle = meta && meta.error_user_title ? String(meta.error_user_title) : "";
  const userMessage = meta && meta.error_user_msg ? String(meta.error_user_msg) : "";
  const display = `${info.title}. ${info.action}`;

  return {
    provider: "meta",
    code: Number.isFinite(code) ? code : null,
    subcode: Number.isFinite(subcode) ? subcode : null,
    httpStatus: Number(options.httpStatus || input?.status || input?.httpStatus || 0) || null,
    type: meta && meta.type ? String(meta.type) : "",
    fbtraceId: meta && meta.fbtrace_id ? String(meta.fbtrace_id) : "",
    userTitle,
    userMessage,
    originalMessage: rawMessage,
    technicalMessage: rawMessage,
    title: info.title,
    category: info.category,
    severity: info.severity || "warning",
    retryable: Boolean(info.retryable || (meta && meta.is_transient)),
    cause: info.cause,
    action: info.action,
    nextSteps: Array.isArray(info.nextSteps) ? info.nextSteps : [],
    display,
    key: Number.isFinite(code) ? `meta_${code}${Number.isFinite(subcode) ? `_${subcode}` : ""}` : `meta_${digitsOnly(rawMessage).slice(0, 8) || "unknown"}`,
    mapped: Boolean(mapped),
  };
}

function summarizeMetaError(errorInfo, fallback) {
  const e = errorInfo && typeof errorInfo === "object" ? errorInfo : normalizeMetaError(fallback || "");
  const code = e.code ? `#${e.code}` : "";
  const sub = e.subcode ? `.${e.subcode}` : "";
  return [e.title, code ? `(${code}${sub})` : ""].filter(Boolean).join(" ");
}

function groupMetaErrors(items = []) {
  const map = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || item.ok) continue;
    const info = item.errorInfo || normalizeMetaError(item.error || item);
    const key = info.key || info.title || "unknown";
    if (!map.has(key)) {
      map.set(key, {
        key,
        title: info.title || "Erro",
        category: info.category || "Erro",
        severity: info.severity || "warning",
        code: info.code || null,
        subcode: info.subcode || null,
        retryable: Boolean(info.retryable),
        cause: info.cause || "",
        action: info.action || "",
        nextSteps: info.nextSteps || [],
        count: 0,
        examples: [],
      });
    }
    const row = map.get(key);
    row.count += 1;
    if (row.examples.length < 5) row.examples.push(item.to || item.toDigits || "");
  }
  return Array.from(map.values()).sort((a, b) => b.count - a.count || String(a.title).localeCompare(String(b.title)));
}

module.exports = {
  META_ERROR_MAP,
  normalizeMetaError,
  summarizeMetaError,
  groupMetaErrors,
};
