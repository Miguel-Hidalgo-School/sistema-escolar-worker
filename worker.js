// Worker: puente seguro entre el Sistema Escolar y Gemini.
// La llave de Gemini NUNCA va aquí en el código — se guarda aparte,
// como "Secreto" en la configuración del Worker (Settings > Variables and Secrets).

const GEMINI_MODEL = 'gemini-2.5-flash'; // modelo gratuito de Google

// Cambia este texto cada vez que subas una corrección importante — así, con solo
// abrir la URL del Worker directo en el navegador (sin pasar por test-worker.html),
// puedes confirmar de inmediato si Cloudflare ya está corriendo el código nuevo,
// sin tener que andar buscando la pestaña de "Deployments".
const VERSION_WORKER = 'interactions-api-v2 (2026-09-06, con diagnóstico de cuerpoCrudo)';

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

    try {
      // Google movió el endpoint de generación a la Interactions API. Las llaves
      // nuevas tipo "AQ." (Auth keys) ya no funcionan con el endpoint viejo
      // ":generateContent" — por eso el Worker dejó de responder.
      const geminiRes = await fetch(
        'https://generativelanguage.googleapis.com/v1beta2/interactions',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': env.GEMINI_API_KEY
          },
          body: JSON.stringify({
            model: GEMINI_MODEL,
            input: prompt
          })
        }
      );

      const rawText = await geminiRes.text();
      let data = null;
      try { data = rawText ? JSON.parse(rawText) : null; } catch (e) { /* dejamos data en null, se reporta abajo */ }

      if (!geminiRes.ok || data === null) {
        return jsonResponse({
          error: 'Gemini devolvió un error',
          status: geminiRes.status,
          statusText: geminiRes.statusText,
          cuerpoCrudo: rawText ? rawText.slice(0, 2000) : '(cuerpo vacío)'
        }, 502);
      }

      const texto = extraerTexto(data);
      return jsonResponse({ texto });
    } catch (err) {
      return jsonResponse({ error: 'No se pudo contactar a Gemini', detalle: String(err) }, 500);
    }
  }
};

// La Interactions API regresa la respuesta como una línea de tiempo de "steps"
// (pensamientos, llamadas a herramientas, texto del modelo, etc.), no como el
// "candidates[0].content.parts[0].text" de antes. Aquí se junta el texto de
// todos los pasos tipo "model_output", en orden.
function extraerTexto(data) {
  const steps = data?.steps || [];
  return steps
    .filter(s => s.type === 'model_output')
    .flatMap(s => (s.content || []).filter(c => c.type === 'text').map(c => c.text))
    .join('')
    .trim();
}

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
