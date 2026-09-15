// Edge Function: crea un usuario (cajero/supervisor/administrador) desde el
// panel de Configuracion → Usuarios y roles.
//
// Por que esto NO se puede hacer directo desde el frontend con supabase-js:
// crear un usuario con contraseña arbitraria (auth.admin.createUser) requiere
// la SERVICE ROLE KEY, que tiene privilegios totales sobre el proyecto y
// JAMAS debe llegar al navegador (cualquiera podria leerla del bundle de JS
// y tomar control completo de la base de datos). Por eso este paso vive en
// una Edge Function: corre en el servidor de Supabase, ahi si es seguro tener
// la service role key (se inyecta sola como variable de entorno, no hay que
// configurarla a mano).
//
// El perfil (tabla public.perfiles) del usuario nuevo se crea SOLO por el
// trigger on_auth_user_created ya existente en supabase/schema.sql — no se
// duplica esa logica aqui. Se le pasa el nombre y el rol elegidos via
// user_metadata, que el trigger ya sabe leer.
//
// Deploy: Supabase Dashboard → Edge Functions → Deploy a new function →
// nombre "crear-usuario" → pega este archivo → Deploy. No requiere configurar
// ningun secreto: SUPABASE_URL, SUPABASE_ANON_KEY y SUPABASE_SERVICE_ROLE_KEY
// ya estan disponibles automaticamente dentro de toda Edge Function.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}

// Mensajes de auth.admin.createUser tal como los devuelve GoTrue (en ingles);
// se traducen los mas comunes para que el administrador entienda el motivo
// sin tener que interpretar un mensaje tecnico.
function traducirError(msg: string): string {
  if (/already.*registered|already.*exists/i.test(msg)) {
    return 'Ya existe un usuario con ese correo electrónico.'
  }
  if (/password/i.test(msg) && /short|weak|length/i.test(msg)) {
    return 'La contraseña es demasiado corta o débil.'
  }
  if (/email/i.test(msg) && /invalid/i.test(msg)) {
    return 'El correo electrónico no es válido.'
  }
  return msg
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS })
  }
  if (req.method !== 'POST') {
    return json({ error: 'Método no permitido.' }, 405)
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    // No deberia pasar nunca en una Edge Function real de Supabase (estas
    // variables se inyectan solas), pero cubre el caso de una mala configuracion.
    return json({ error: 'La función no está configurada correctamente en el servidor.' }, 500)
  }

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return json({ error: 'No autorizado.' }, 401)
    }

    // Cliente "como quien llama": usa el JWT de la sesion del que invoca la
    // funcion (no la service role) para saber quien es y respetar RLS al
    // leer su propio perfil — nunca se confia en un "soy administrador"
    // que mande el propio body de la peticion.
    const clienteLlamador = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false },
    })

    const { data: userData, error: userError } = await clienteLlamador.auth.getUser()
    if (userError || !userData.user) {
      return json({ error: 'Sesión inválida o expirada.' }, 401)
    }

    const { data: perfilLlamador, error: perfilError } = await clienteLlamador
      .from('perfiles')
      .select('rol, activo')
      .eq('id', userData.user.id)
      .single()

    if (perfilError || !perfilLlamador || perfilLlamador.rol !== 'administrador' || !perfilLlamador.activo) {
      return json({ error: 'Solo un administrador puede crear usuarios.' }, 403)
    }

    let body: { email?: unknown; password?: unknown; nombre?: unknown; rol?: unknown }
    try {
      body = await req.json()
    } catch {
      return json({ error: 'Cuerpo de la petición inválido.' }, 400)
    }

    const email = typeof body.email === 'string' ? body.email.trim() : ''
    const password = typeof body.password === 'string' ? body.password : ''
    const nombre = typeof body.nombre === 'string' ? body.nombre.trim() : ''
    const rolPedido = typeof body.rol === 'string' ? body.rol : 'cajero'

    if (!email || !email.includes('@')) {
      return json({ error: 'Ingresa un correo electrónico válido.' }, 400)
    }
    if (!nombre) {
      return json({ error: 'El nombre es obligatorio.' }, 400)
    }
    if (!password || password.length < 6) {
      return json({ error: 'La contraseña debe tener al menos 6 caracteres.' }, 400)
    }
    // Nunca se confia ciegamente en el rol enviado desde el frontend mas alla
    // de esta lista fija — igual que el resto de RPCs del sistema.
    const rol = rolPedido === 'administrador' || rolPedido === 'supervisor' ? rolPedido : 'cajero'

    // Cliente con privilegios de servicio — SOLO se usa para este unico paso
    // (crear el usuario), nunca se expone ni se reutiliza para nada mas.
    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })

    const { data: creado, error: crearError } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true, // el administrador ya lo valida al crearlo: no hace falta que el cajero confirme su correo para poder ingresar
      user_metadata: { nombre, rol },
    })

    if (crearError) {
      return json({ error: traducirError(crearError.message) }, 400)
    }

    return json({ id: creado.user?.id, email: creado.user?.email, nombre, rol }, 200)
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'Error inesperado del servidor.' }, 500)
  }
})
