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
const AI_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast'; // modelo gratuito de Cloudflare, bueno en español (confirmado en el catálogo gratuito vigente)

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
const VERSION_WORKER = 'cloudflare-workers-ai-v4 (2026-09-06, ajustado a lectoescritura inicial en 1°-2° primaria)';

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
        // Temperatura más alta = menos determinista. Sin esto, el modelo puede
        // regresar una redacción muy parecida (o idéntica) cada vez que se le
        // pide lo mismo, que es justo lo que no se quiere en el botón
        // "Sugerir con IA" cuando se le da clic varias veces seguidas.
        temperature: 0.9
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
    const { campo, nivel, alumno, grado, comentariosExistentes, comentarioAnterior } = body;
    const nivelTexto = { verde: 'nivel esperado', amarillo: 'en desarrollo', rojo: 'requiere apoyo' }[nivel] || nivel;
    return `Eres un docente mexicano de educación básica redactando una evaluación formativa. Escribe SOLO un comentario breve (máximo 2 renglones, en español, tono constructivo y profesional) para el campo formativo o aspecto "${campo}" de la o el alumno ${alumno || ''} (${grado || ''}), cuyo nivel de logro es "${nivelTexto}". Ajusta el comentario a lo que realmente se espera en ese grado: por ejemplo, en 1° y 2° de primaria los niños apenas están adquiriendo la lectoescritura (aprendiendo a leer y escribir), así que no des por hecho que ya leen o escriben con fluidez — describe su proceso inicial (reconocimiento de letras, sonidos, trazos, etc.) en vez de exigir dominio. ${comentariosExistentes ? `Toma en cuenta que ya se escribió esto para otro aspecto, para no repetir frases: "${comentariosExistentes}".` : ''} ${comentarioAnterior ? `Ya se generó antes este otro comentario para el mismo aspecto y no convenció, así que redáctalo de forma distinta, con otras palabras y otro enfoque, sin repetir su estructura ni sus frases: "${comentarioAnterior}".` : ''} No agregues saludo, ni el nombre del alumno, ni explicaciones extra — solo el comentario.`;
  }

  if (task === 'formativo_fortalezas_areas') {
    const { criterios, campo, textoAnterior, grado } = body; // campo: 'fortalezas' | 'areasOportunidad'
    const resumenCriterios = (criterios || []).map(c => `- ${c.nombre}: ${({verde:'nivel esperado',amarillo:'en desarrollo',rojo:'requiere apoyo'})[c.nivel] || c.nivel}${c.comentario ? ' — ' + c.comentario : ''}`).join('\n');
    const pedir = campo === 'areasOportunidad' ? 'áreas de oportunidad (lo que necesita reforzar)' : 'fortalezas (lo que hace bien)';
    return `Eres un docente mexicano de educación básica. A partir de esta evaluación por aspecto de un alumno de ${grado || 'grado no especificado'}, redacta de 2 a 3 ${pedir}, en español, una por línea, en tono constructivo. Ajusta las expectativas a lo que realmente corresponde a ese grado: por ejemplo, en 1° y 2° de primaria los niños apenas están adquiriendo la lectoescritura, así que no des por hecho que ya leen o escriben con fluidez. Responde SOLO con las líneas, sin numerarlas ni agregar explicaciones. ${textoAnterior ? `Ya se generó antes este texto y no convenció, así que redáctalo distinto, con otras palabras: "${textoAnterior}".` : ''}

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
