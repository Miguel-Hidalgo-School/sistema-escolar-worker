// Worker: puente entre el Sistema Escolar y una IA para generar sugerencias de texto.
// Usa Cloudflare Workers AI (el propio servicio de IA de Cloudflare), NO Gemini.
// ¿Por qué el cambio? Gemini migró sus llaves de API al formato nuevo "AQ." y ese
// formato no funciona con llamadas HTTP directas (ni con x-goog-api-key, ni con
// ?key=, ni con Authorization: Bearer) — es un problema de Google, no de este código,
// y muchos desarrolladores lo están reportando en su foro oficial sin solución aún.
// Cloudflare Workers AI evita todo esto: no necesita ninguna llave externa, ya viene
// conectado directo a este mismo Worker (se activa como un "Binding" en la
// configuración de Cloudflare, ver más abajo), y tiene una capa gratuita amplia
// (10,000 "Neurons" gratis al día) que le sobra a un solo colegio.
const AI_MODEL = '@cf/openai/gpt-oss-120b'; // modelo gratuito de Cloudflare (120B parámetros, de OpenAI) — más capaz que llama-3.3-70b para tareas de redacción

// Cambia este texto cada vez que subas una corrección importante — así, con solo
// abrir la URL del Worker directo en el navegador (sin pasar por test-worker.html),
// puedes confirmar de inmediato si Cloudflare ya está corriendo el código nuevo,
// sin tener que andar buscando la pestaña de "Deployments".
// NOTA: el catálogo de modelos gratuitos de Cloudflare cambia con el tiempo (ya nos
// pasó una vez: llama-3.1-8b-instruct fue retirado el 30 de mayo de 2026). Si en el
// futuro este Worker vuelve a fallar con un error de "deprecated" o "model not
// found", la solución es la misma: cambiar AI_MODEL de arriba por el modelo vigente
// que indique https://developers.cloudflare.com/workers-ai/models/ (categoría
// "Text Generation"), sin tocar nada más del código.
const VERSION_WORKER = 'cloudflare-workers-ai-v9 (2026-09-07, reforzada regla de nivel-de-logro realista con ejemplos y auto-revisión, temperatura bajada a 0.6)';

export default {
  async fetch(request, env) {
    // Responder a la verificación previa (CORS) que hace el navegador
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    // Al abrir la URL directo en el navegador (GET), regresa solo la versión —
    // así puedes confirmar el despliegue sin usar test-worker.html.
    if (request.method === 'GET') {
      return jsonResponse({ version: VERSION_WORKER });
    }

    if (request.method !== 'POST') {
      return jsonResponse({ error: 'Método no permitido' }, 405);
    }

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return jsonResponse({ error: 'JSON inválido' }, 400);
    }

    const prompt = construirPrompt(body);
    if (!prompt) {
      return jsonResponse({ error: 'Falta indicar la tarea (task) o los datos' }, 400);
    }

    // Si esto falla con "AI is not defined" o similar, falta activar el Binding:
    // en Cloudflare → tu Worker → Settings → Bindings → Add → "Workers AI" →
    // nómbralo exactamente "AI" → Guardar y volver a desplegar.
    if (!env.AI) {
      return jsonResponse({
        error: 'Falta activar el Binding de Workers AI en este Worker (Settings → Bindings → Add → Workers AI, nómbralo "AI").'
      }, 500);
    }

    try {
      const resultado = await env.AI.run(AI_MODEL, {
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 300,
        // Temperatura moderada: con 0.9 el modelo "improvisaba" y a veces
        // ignoraba la regla de nivel-de-logro realista (le atribuía al alumno
        // habilidades que su nivel no permite). 0.6 sigue dando variación entre
        // clics repetidos de "Sugerir con IA", pero respeta mejor las reglas
        // estrictas del prompt (ver REGLA #1 en construirPrompt).
        temperature: 0.6
      });
      // Distintos modelos de Workers AI regresan el texto en distinta forma:
      // los de la familia Llama usan { response: "..." }, mientras que los
      // compatibles con el formato de OpenAI (como gpt-oss) usan
      // { choices: [{ message: { content: "..." } }] }. Se revisan ambas.
      const texto = (
        resultado?.response ||
        resultado?.choices?.[0]?.message?.content ||
        ''
      ).trim();
      if (!texto) {
        return jsonResponse({ error: 'La IA respondió, pero sin texto reconocible', respuestaCruda: resultado }, 502);
      }
      return jsonResponse({ texto });
    } catch (err) {
      return jsonResponse({ error: 'No se pudo generar el texto con la IA', detalle: String(err) }, 500);
    }
  }
};

// Arma la instrucción exacta que se le manda a la IA, según qué módulo
// del Sistema Escolar esté llamando al Worker.
function construirPrompt(body) {
  const { task } = body;

  if (task === 'reporte_resumen') {
    const { grade, grupo, materia, docente, alumnos } = body;
    const listaAlumnos = (alumnos || []).map(a =>
      `- ${a.nombre}: P1=${a.p1 ?? '—'}, P2=${a.p2 ?? '—'}, P3=${a.p3 ?? '—'}, suma=${a.suma}, estatus=${a.estatus}`
    ).join('\n');
    return `Eres un asistente de una escuela secundaria en México. Con estos datos de calificaciones de un grupo, escribe un resumen breve (máximo 120 palabras) en español, en tono profesional pero claro, dirigido a la persona de Gestión Escolar. Menciona el desempeño general del grupo, cuántos están en riesgo y cuántos van bien pero les faltan periodos, y si hay algún patrón que valga la pena señalar (por ejemplo, si todos sacaron lo mismo en un periodo). No repitas la tabla completa, solo el resumen.

Materia: ${materia || '—'}
Docente: ${docente || '—'}
Grado y grupo: ${grade || ''} ${grupo || ''}

Alumnos:
${listaAlumnos}`;
  }

  if (task === 'formativo_sugerencia') {
    const { campo, nivel, alumno, grado, comentariosExistentes, comentarioAnterior, contexto } = body;
    const nivelTexto = { verde: 'nivel esperado', amarillo: 'en desarrollo', rojo: 'requiere apoyo' }[nivel] || nivel;
    return `Eres un docente mexicano de educación básica con 20 años de experiencia redactando evaluaciones formativas oficiales.

REGLA #1, INQUEBRANTABLE — LÉELA DOS VECES ANTES DE ESCRIBIR:
El nivel de logro de este alumno en este aspecto es "${nivelTexto}". SOLO puedes describir lo que ese nivel permite:
- "requiere apoyo" (rojo) = apenas está empezando, batalla con esto, NO lo domina, necesita ayuda directa y constante del docente. Describe el intento, el proceso o la dificultad — nunca el logro terminado.
- "en desarrollo" (amarillo) = lo logra A VECES, de forma inconsistente, con apoyo ocasional. Va mejorando pero todavía no es autónomo.
- "nivel esperado" (verde) = lo logra de forma consistente y autónoma para su edad y grado.
Está PROHIBIDO describir una habilidad más avanzada que la que el nivel indicado permite, sin importar el aspecto de que se trate (lectura, escritura, matemáticas, conducta, motricidad, lo que sea). Si tienes duda, describe MENOS habilidad, no más.

EJEMPLO (aspecto "Expresión escrita", nivel "requiere apoyo"):
❌ MAL: "El alumno redacta correctamente sus ideas con oraciones completas." (le atribuye una habilidad que el nivel "requiere apoyo" no permite)
✅ BIEN: "Kevin aún requiere apoyo constante para expresar sus ideas por escrito; con ayuda directa logra trazar letras y palabras cortas."

Contexto adicional de este caso:
- Aspecto a comentar: "${campo}"
- Alumno(a): ${alumno || 'sin nombre'}
- Grado: ${grado || 'no especificado'}
${contexto ? `- PRIORIDAD MÁXIMA — así está el grupo en realidad ahora mismo, según quien lo evalúa, por encima de cualquier suposición general: "${contexto}"` : ''}
${comentariosExistentes ? `- Ya se escribió esto para otro aspecto del mismo alumno; no repitas frases: "${comentariosExistentes}"` : ''}
${comentarioAnterior ? `- Este comentario ya se generó antes para el mismo aspecto y no convenció; redáctalo distinto, con otras palabras y otro enfoque, sin repetir su estructura: "${comentarioAnterior}"` : ''}

TAREA: Escribe SOLO el comentario final (máximo 2 renglones, en español, tono profesional y constructivo, propio de un docente mexicano). Sin saludo, sin repetir el nombre del alumno al inicio, sin explicaciones, sin comillas. Antes de responder, revisa tu propio comentario contra la REGLA #1 y corrígelo si le atribuye más de lo que el nivel "${nivelTexto}" permite.`;
  }

  if (task === 'formativo_fortalezas_areas') {
    const { criterios, campo, textoAnterior, grado, contexto } = body; // campo: 'fortalezas' | 'areasOportunidad'
    const resumenCriterios = (criterios || []).map(c => `- ${c.nombre}: ${({verde:'nivel esperado',amarillo:'en desarrollo',rojo:'requiere apoyo'})[c.nivel] || c.nivel}${c.comentario ? ' — ' + c.comentario : ''}`).join('\n');
    const pedir = campo === 'areasOportunidad' ? 'áreas de oportunidad (lo que necesita reforzar)' : 'fortalezas (lo que hace bien)';
    return `Eres un docente mexicano de educación básica con 20 años de experiencia redactando evaluaciones formativas oficiales.

REGLA #1, INQUEBRANTABLE — LÉELA DOS VECES ANTES DE ESCRIBIR:
Cada aspecto de abajo trae su propio nivel de logro. SOLO puedes describir lo que ese nivel permite:
- "requiere apoyo" (rojo) = apenas está empezando, batalla con esto, NO lo domina, necesita ayuda directa y constante.
- "en desarrollo" (amarillo) = lo logra A VECES, de forma inconsistente, con apoyo ocasional.
- "nivel esperado" (verde) = lo logra de forma consistente y autónoma para su edad y grado.
Está PROHIBIDO describir, ni siquiera en las "fortalezas", una habilidad más avanzada que la que el nivel de ese aspecto indica. Un aspecto en "requiere apoyo" o "en desarrollo" puede tener una fortaleza legítima (ej. "muestra disposición a intentarlo", "responde bien a la guía del docente"), pero NUNCA se le atribuye el logro completo. Si tienes duda, describe MENOS habilidad, no más.

EJEMPLO (aspecto "Expresión escrita" en "requiere apoyo"):
❌ MAL (como fortaleza): "Redacta oraciones completas y coherentes." (habilidad que ese nivel no permite)
✅ BIEN (como fortaleza): "Muestra buena disposición para intentar trazar letras y palabras, aunque aún con apoyo."

Grado: ${grado || 'no especificado'}
${contexto ? `PRIORIDAD MÁXIMA — así está el grupo en realidad ahora mismo, según quien lo evalúa, por encima de cualquier suposición general: "${contexto}"` : ''}
${textoAnterior ? `Ya se generó antes este texto y no convenció; redáctalo distinto, con otras palabras: "${textoAnterior}"` : ''}

Evaluación por aspecto:
${resumenCriterios}

TAREA: Redacta de 2 a 3 ${pedir}, en español, una por línea, tono profesional y constructivo. Responde SOLO con las líneas, sin numerarlas, sin comillas, sin explicaciones. Antes de responder, revisa cada línea contra la REGLA #1 y corrígela si le atribuye más de lo que el nivel de ese aspecto permite.`;
  }

  return null;
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() }
  });
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
}
