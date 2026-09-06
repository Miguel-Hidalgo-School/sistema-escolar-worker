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
const AI_MODEL = '@cf/meta/llama-3.1-8b-instruct'; // modelo gratuito de Cloudflare, bueno en español

// Cambia este texto cada vez que subas una corrección importante — así, con solo
// abrir la URL del Worker directo en el navegador (sin pasar por test-worker.html),
// puedes confirmar de inmediato si Cloudflare ya está corriendo el código nuevo,
// sin tener que andar buscando la pestaña de "Deployments".
const VERSION_WORKER = 'cloudflare-workers-ai-v1 (2026-09-06, sin depender de Gemini)';

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
        max_tokens: 300
      });
      const texto = (resultado && resultado.response) ? resultado.response.trim() : '';
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
    const { campo, nivel, alumno, grado, comentariosExistentes } = body;
    const nivelTexto = { verde: 'nivel esperado', amarillo: 'en desarrollo', rojo: 'requiere apoyo' }[nivel] || nivel;
    return `Eres un docente mexicano de educación básica redactando una evaluación formativa. Escribe SOLO un comentario breve (máximo 2 renglones, en español, tono constructivo y profesional) para el campo formativo o aspecto "${campo}" de la o el alumno ${alumno || ''} (${grado || ''}), cuyo nivel de logro es "${nivelTexto}". ${comentariosExistentes ? `Toma en cuenta que ya se escribió esto para otro aspecto, para no repetir frases: "${comentariosExistentes}".` : ''} No agregues saludo, ni el nombre del alumno, ni explicaciones extra — solo el comentario.`;
  }

  if (task === 'formativo_fortalezas_areas') {
    const { criterios, campo } = body; // campo: 'fortalezas' | 'areasOportunidad'
    const resumenCriterios = (criterios || []).map(c => `- ${c.nombre}: ${({verde:'nivel esperado',amarillo:'en desarrollo',rojo:'requiere apoyo'})[c.nivel] || c.nivel}${c.comentario ? ' — ' + c.comentario : ''}`).join('\n');
    const pedir = campo === 'areasOportunidad' ? 'áreas de oportunidad (lo que necesita reforzar)' : 'fortalezas (lo que hace bien)';
    return `Eres un docente mexicano de educación básica. A partir de esta evaluación por aspecto de un alumno, redacta de 2 a 3 ${pedir}, en español, una por línea, en tono constructivo. Responde SOLO con las líneas, sin numerarlas ni agregar explicaciones.

Evaluación por aspecto:
${resumenCriterios}`;
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
