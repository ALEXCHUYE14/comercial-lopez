// Edge Function: consulta el nombre de un DNI (RENIEC) o la razon social y
// direccion de un RUC (SUNAT) a traves de DECOLECTA (antes apis.net.pe), para
// llenar solos los datos del cliente al emitir una boleta o factura.
//
// El TOKEN de Decolecta vive SOLO aqui, como secreto de Supabase:
//   CONSULTA_DOC_TOKEN -> token de decolecta.com
//
// Deploy: Supabase Dashboard -> Edge Functions -> Deploy a new function ->
// nombre "consultar-documento" -> pega este archivo -> Deploy.
//
// Body JSON: { tipo: 'dni' | 'ruc', numero: '12345678' | '20123456789' }
// Respuesta: { encontrado: boolean, nombre?, direccion?, estado?, condicion? }
//
// Solo usuarios con sesion y activos pueden usarla (protege la cuota del
// token). Nunca bloquea una venta: si falla, el cajero escribe el nombre a mano.

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const API = 'https://api.decolecta.com/v1'
const TIMEOUT_MS = 8000
const CACHE_MS = 60 * 60 * 1000 // 1 hora: ahorra consultas repetidas del mismo documento
const CACHE_MAX = 500

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}

/** Texto limpio: sin caracteres de control, espacios colapsados, con tope. */
function limpio(v: unknown, max: number): string {
  if (typeof v !== 'string') return ''
  return v.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
}

/** Une partes de direccion ignorando vacios y guiones ("-"). */
function unir(partes: unknown[], sep: string): string {
  return partes.map((p) => limpio(p, 120)).filter((p) => p && p !== '-').join(sep)
}

type Resultado = { encontrado: boolean; nombre?: string; direccion?: string; estado?: string; condicion?: string }

// Cache en memoria de esta instancia (se pierde al reiniciar; es solo ahorro).
const cache = new Map<string, { t: number; r: Resultado }>()

async function consultar(tipo: 'dni' | 'ruc', numero: string, token: string): Promise<Resultado | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const url = tipo === 'dni'
      ? `${API}/reniec/dni?numero=${encodeURIComponent(numero)}`
      : `${API}/sunat/ruc?numero=${encodeURIComponent(numero)}`
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: ctrl.signal,
    })
    // 400/404/422: documento invalido o inexistente -> "no encontrado".
    if (res.status === 400 || res.status === 404 || res.status === 422) return { encontrado: false }
    if (!res.ok) return null // token invalido, limite superado, caida del servicio
    const d = (await res.json()) as Record<string, unknown>

    if (tipo === 'dni') {
      const nombre =
        limpio(d.full_name, 200) ||
        unir([d.first_last_name, d.second_last_name, d.first_name], ' ')
      return nombre ? { encontrado: true, nombre } : { encontrado: false }
    }

    const nombre = limpio(d.razon_social, 200)
    if (!nombre) return { encontrado: false }
    const base = limpio(d.direccion, 200)
    const ubic = unir([d.distrito, d.provincia, d.departamento], ' - ')
    const direccion = base && base !== '-' ? (ubic ? `${base}, ${ubic}` : base) : ''
    return {
      encontrado: true,
      nombre,
      direccion: direccion.slice(0, 250),
      estado: limpio(d.estado, 40),
      condicion: limpio(d.condicion, 40),
    }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (req.method !== 'POST') return json({ error: 'Método no permitido.' }, 405)

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  const token = (Deno.env.get('CONSULTA_DOC_TOKEN') ?? '').trim()
  if (!supabaseUrl || !anonKey) return json({ error: 'La función no está configurada correctamente.' }, 500)
  if (!token) return json({ error: 'Falta el secreto CONSULTA_DOC_TOKEN en Supabase.' }, 500)

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'No autorizado.' }, 401)

  try {
    // Sesion valida y usuario activo (verificado en la base, no en el body).
    // Se usa la API REST directamente para no cargar una libreria completa.
    const headers = { Authorization: authHeader, apikey: anonKey }
    const [userRes, body] = await Promise.all([
      fetch(`${supabaseUrl}/auth/v1/user`, { headers }),
      req.json().catch(() => null),
    ])
    if (!userRes.ok) return json({ error: 'Sesión inválida o expirada.' }, 401)
    const user = (await userRes.json()) as { id?: string }
    if (!user?.id || !/^[0-9a-f-]{36}$/i.test(user.id)) return json({ error: 'Sesión inválida.' }, 401)
    const perfRes = await fetch(
      `${supabaseUrl}/rest/v1/perfiles?select=activo&id=eq.${user.id}`,
      { headers },
    )
    const perfiles = perfRes.ok ? ((await perfRes.json()) as { activo: boolean }[]) : []
    if (!perfiles[0]?.activo) return json({ error: 'Tu usuario está inactivo.' }, 403)

    const tipo = body?.tipo === 'ruc' ? 'ruc' : body?.tipo === 'dni' ? 'dni' : null
    const numero = typeof body?.numero === 'string' ? body.numero.replace(/\D/g, '') : ''
    if (!tipo) return json({ error: 'Tipo de documento inválido.' }, 400)
    if (tipo === 'dni' && !/^\d{8}$/.test(numero)) return json({ error: 'El DNI debe tener 8 dígitos.' }, 400)
    if (tipo === 'ruc' && !/^(10|15|16|17|20)\d{9}$/.test(numero)) {
      return json({ error: 'El RUC debe tener 11 dígitos y empezar con 10 o 20.' }, 400)
    }

    const clave = `${tipo}:${numero}`
    const enCache = cache.get(clave)
    if (enCache && Date.now() - enCache.t < CACHE_MS) return json(enCache.r, 200)

    const r = await consultar(tipo, numero, token)
    if (!r) return json({ error: 'El servicio de consulta no respondió. Escribe los datos a mano.' }, 502)

    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string)
    cache.set(clave, { t: Date.now(), r })
    return json(r, 200)
  } catch {
    return json({ error: 'Error inesperado al consultar el documento.' }, 500)
  }
})
