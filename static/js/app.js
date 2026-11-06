"use strict";

/* ============================================================
   Turnero web - cliente
   El estado vive en el servidor (Neon); el cliente lo consulta cada
   2 segundos, así varias pantallas se mantienen sincronizadas.
   Todo el texto dinámico se inserta con textContent (sin innerHTML).
   ============================================================ */

const MODO_PANTALLA = new URLSearchParams(location.search).get("modo") === "pantalla";
if (MODO_PANTALLA) document.body.classList.add("pantalla");

const LS_EMP = "turnero_empleado_sugerido";
const $ = (sel) => document.querySelector(sel);

let estado = null;
let ultimoActualId;      // undefined = aún no se ha pintado nada
let enCurso = false;
let secuencia = 0;
let listaActiva = null;

function el(tag, clase, texto) {
  const n = document.createElement(tag);
  if (clase) n.className = clase;
  if (texto !== undefined && texto !== null) n.textContent = texto;
  return n;
}

function leerLS(clave) {
  try { return localStorage.getItem(clave) || ""; } catch (_) { return ""; }
}
function guardarLS(clave, valor) {
  try { localStorage.setItem(clave, valor); } catch (_) { /* sin almacenamiento */ }
}

/* ---------------- API ---------------- */
async function api(url, { method = "GET", body } = {}) {
  const resp = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await resp.json(); } catch (_) { /* respuesta sin JSON */ }
  if (!resp.ok) {
    const err = new Error(data.error || `Error ${resp.status}`);
    err.status = resp.status;
    throw err;
  }
  return data;
}

function aplicar(nuevo) {
  secuencia++;            // invalida sondeos que estaban en vuelo
  estado = nuevo;
  render();
}

async function refrescar() {
  const mi = ++secuencia;
  try {
    const e = await api("/api/estado");
    if (mi !== secuencia) return;
    estado = e;
    render();
    $("#conexion").classList.remove("caida");
  } catch (_) {
    $("#conexion").classList.add("caida");
  }
}

/* ---------------- Render ---------------- */
function destello() {
  const n = $("#turno-actual");
  n.classList.remove("flash");
  void n.offsetWidth;
  n.classList.add("flash");
}

function actualizarEtiquetaEmpleado() {
  const etiqueta = $("#etiqueta-empleado");
  if (estado && !estado.ajustes.empleado_obligatorio) {
    etiqueta.textContent = "Empleado: (modo opcional)";
    return;
  }
  const emp = $("#input-empleado").value.trim() || "(ninguno)";
  etiqueta.textContent = `Empleado: ${emp}`;
}

function render() {
  const e = estado;
  if (!e) return;

  $("#turno-espera").textContent = e.ultimo_espera || "—";
  $("#contador-espera").textContent = `Total en cola: ${e.espera.length} turnos`;

  const actual = e.actual;
  $("#turno-actual").textContent = actual ? actual.codigo : "—";
  $("#empleado-atencion").textContent =
    actual && actual.empleado ? `👤 Atiende: ${actual.empleado}` : "—";
  $("#contador-atencion").textContent = `Total en atención: ${e.atencion.length} turnos`;

  if (actual && ultimoActualId !== undefined && ultimoActualId !== actual.id) destello();
  ultimoActualId = actual ? actual.id : null;

  const bEmp = $("#btn-toggle-empleado");
  const obligatorio = e.ajustes.empleado_obligatorio;
  bEmp.textContent = obligatorio ? "🔒 Empleado: OBLIGATORIO" : "🔓 Empleado: OPCIONAL";
  bEmp.className = "btn " + (obligatorio ? "rojo" : "verde");

  const bCot = $("#btn-toggle-cotizacion");
  const cot = e.ajustes.cotizacion_activa;
  bCot.textContent = cot ? "📝 Cotización: ON" : "📝 Cotización: OFF";
  bCot.className = "btn " + (cot ? "cian" : "gris");

  actualizarEtiquetaEmpleado();

  const s = e.stats;
  $("#stats").textContent =
    `Sesión: ${e.sesion_inicio}  |  Generados: ${s.generados}  |  ` +
    `Atendidos: ${s.atendidos}  |  Limpiados: ${s.limpiados}  |  ` +
    `Espera: ${s.espera}  |  Atención: ${s.atencion}  |  ` +
    `Emp: ${obligatorio ? "OBLIGATORIO" : "OPCIONAL"}  |  Cot: ${cot ? "ON" : "OFF"}`;

  if (listaActiva) listaActiva.pintar();
}

/* ---------------- Diálogos ---------------- */
function dialogo({ titulo, color = "azul", clase = "", contenido = [], botones = [], onMontar }) {
  return new Promise((resolve) => {
    const dlg = el("dialog", `dlg ${clase}`.trim());
    dlg.dataset.color = color;
    let resultado = null;
    const ctl = {
      dlg,
      cerrar: (valor = null) => { resultado = valor; dlg.close(); },
    };

    const cuerpo = el("div", "dlg-cuerpo");
    contenido.forEach((n) => cuerpo.append(n));

    const pie = el("div", "dlg-pie");
    botones.forEach((b) => {
      const btn = el("button", `btn ${b.clase || "gris"}`, b.texto);
      btn.type = "button";
      btn.addEventListener("click", async () => {
        if (b.onClick) await b.onClick(ctl, btn);
        else ctl.cerrar(b.valor === undefined ? null : b.valor);
      });
      pie.append(btn);
    });

    dlg.append(el("h3", "dlg-titulo", titulo), cuerpo, pie);
    dlg.addEventListener("close", () => { dlg.remove(); resolve(resultado); });
    document.body.append(dlg);
    dlg.showModal();
    if (onMontar) onMontar(ctl);
  });
}

function aviso(titulo, mensaje, color = "azul") {
  return dialogo({
    titulo,
    color,
    contenido: [el("p", "dlg-msg", mensaje)],
    botones: [{ texto: "Aceptar", clase: color, valor: true }],
  });
}

function confirmar({ titulo, mensaje, color = "naranja", si = "Sí", no = "No" }) {
  return dialogo({
    titulo,
    color,
    contenido: [el("p", "dlg-msg", mensaje)],
    botones: [
      { texto: no, clase: "gris", valor: false },
      { texto: si, clase: color, valor: true },
    ],
    onMontar: (ctl) => {
      const btnNo = ctl.dlg.querySelector(".btn.gris");
      if (btnNo) btnNo.focus();     // por seguridad, el foco inicial es "No"
    },
  }).then((r) => r === true);
}

/* campos: [{name, label, tipo, placeholder, maxlength, inputmode, valor, grande,
             autocomplete, limpiarEnError, opciones}]
   validar(valores) -> string con el error, o null si todo está bien (puede ser async) */
function formulario({ titulo, color = "morado", descripcion, info, campos, aceptar, cancelar = "Cancelar", validar }) {
  const err = el("div", "dlg-error");
  const inputs = {};
  const contenido = [];

  if (descripcion) contenido.push(el("p", "dlg-desc", descripcion));
  if (info) {
    const caja = el("div", "dlg-info");
    info.forEach(([k, v]) => {
      const linea = el("div");
      linea.append(el("b", null, k + ": "), document.createTextNode(v));
      caja.append(linea);
    });
    contenido.push(caja);
  }

  campos.forEach((c) => {
    const wrap = el("label", "campo");
    if (c.label) wrap.append(el("span", "campo-label", c.label));
    let inp;
    if (c.tipo === "select") {
      inp = el("select", "campo-input");
      c.opciones.forEach(([valor, texto]) => {
        const o = el("option", null, texto);
        o.value = valor;
        inp.append(o);
      });
    } else {
      inp = el("input", "campo-input" + (c.grande ? " grande" : ""));
      inp.type = c.tipo || "text";
      if (c.placeholder) inp.placeholder = c.placeholder;
      if (c.maxlength) inp.maxLength = c.maxlength;
      if (c.inputmode) inp.inputMode = c.inputmode;
      inp.autocomplete = c.autocomplete || "off";
      if (c.valor) inp.value = c.valor;
    }
    inputs[c.name] = inp;
    wrap.append(inp);
    contenido.push(wrap);
  });
  contenido.push(err);

  let validando = false;
  const enviar = async (ctl) => {
    if (validando) return;
    const valores = {};
    campos.forEach((c) => { valores[c.name] = inputs[c.name].value; });

    validando = true;
    let msg = null;
    try {
      msg = validar ? await validar(valores) : null;
    } catch (e) {
      msg = "❌ " + e.message;
    } finally {
      validando = false;
    }

    if (msg) {
      err.textContent = msg;
      campos.forEach((c) => {
        if (c.limpiarEnError) inputs[c.name].value = "";
      });
      const foco = campos.find((c) => c.limpiarEnError);
      if (foco) inputs[foco.name].focus();
      Object.values(inputs).forEach((i) => {
        if (i.tagName === "INPUT") {
          i.classList.add("error");
          setTimeout(() => i.classList.remove("error"), 1500);
        }
      });
      return;
    }
    ctl.cerrar(valores);
  };

  return dialogo({
    titulo,
    color,
    contenido,
    botones: [
      { texto: cancelar, clase: "gris", valor: null },
      { texto: aceptar, clase: color, onClick: (ctl) => enviar(ctl) },
    ],
    onMontar: (ctl) => {
      const todos = campos.map((c) => inputs[c.name]);
      todos.forEach((inp, i) => {
        inp.addEventListener("keydown", (ev) => {
          if (ev.key !== "Enter") return;
          ev.preventDefault();
          if (i < todos.length - 1) todos[i + 1].focus();
          else enviar(ctl);
        });
        inp.addEventListener("input", () => { err.textContent = ""; });
      });
      if (todos[0]) {
        todos[0].focus();
        if (todos[0].select) todos[0].select();
      }
    },
  });
}

function envolver(tabla) {
  const w = el("div", "tabla-wrap");
  w.append(tabla);
  return w;
}

function tablaPares(pares) {
  const t = el("table", "tabla");
  const thead = el("thead");
  const trh = el("tr");
  ["Concepto", "Valor"].forEach((x) => trh.append(el("th", null, x)));
  thead.append(trh);
  const tb = el("tbody");
  pares.forEach(([k, v]) => {
    const tr = el("tr");
    tr.append(el("td", null, k), el("td", null, String(v)));
    tb.append(tr);
  });
  t.append(thead, tb);
  return envolver(t);
}

/* ---------------- Ejecución protegida ---------------- */
async function ejecutar(fn) {
  if (enCurso) return;
  enCurso = true;
  try {
    await fn();
  } catch (e) {
    await aviso("⚠️ Aviso", e.message, "naranja");
    refrescar();
  } finally {
    enCurso = false;
  }
}

/* ---------------- Credenciales ---------------- */
async function pedirCredenciales(motivo, permitirSub) {
  let creds = null;
  const v = await formulario({
    titulo: "🔐 Acceso al Sistema",
    color: "morado",
    descripcion: "Ingresa tus credenciales para continuar:",
    campos: [
      { name: "usuario", label: "👤 Usuario:", placeholder: "Usuario (admin / sub_admin)", autocomplete: "username" },
      { name: "password", label: "🔑 Contraseña:", tipo: "password", placeholder: "Contraseña", autocomplete: "current-password", limpiarEnError: true },
    ],
    aceptar: "Ingresar",
    validar: async (val) => {
      try {
        const r = await api("/api/auth/verificar", {
          method: "POST",
          body: { usuario: val.usuario, password: val.password, permitir_sub_admin: permitirSub, motivo },
        });
        creds = { usuario: val.usuario, password: val.password, rol: r.rol };
        return null;
      } catch (e) {
        return "❌ " + e.message;
      }
    },
  });
  return v ? creds : null;
}

/* ---------------- Acciones ---------------- */
function nuevoTurno() {
  return ejecutar(async () => {
    const r = await api("/api/turnos", { method: "POST" });
    aplicar(r.estado);
  });
}

async function solicitarCotizacion(turno, manual) {
  const titulo = manual ? "📝 Registrar Cotización (Alt+C)" : "📝 Registro de Cotización";
  const v = await formulario({
    titulo,
    color: "cian",
    info: [["Turno", turno.codigo], ["Empleado", turno.empleado || "(sin empleado)"]],
    descripcion: "Ingresa los últimos 6 dígitos de la cotización generada:",
    campos: [
      { name: "cotizacion", placeholder: "Últimos 6 números (ej: 123456)", maxlength: 6, inputmode: "numeric", grande: true },
    ],
    aceptar: "✅ Registrar",
    cancelar: "Omitir",
    validar: async (val) => {
      const c = val.cotizacion.trim();
      if (!c) return "❌ Debes ingresar los últimos 6 dígitos";
      if (!/^[0-9]{6}$/.test(c)) return "❌ Deben ser exactamente 6 dígitos numéricos";
      try {
        const r = await api(`/api/turnos/${turno.id}/cotizacion`, { method: "POST", body: { cotizacion: c } });
        aplicar(r.estado);
        return null;
      } catch (e) {
        return "❌ " + e.message;
      }
    },
  });
  if (v && manual) {
    await aviso("✅ Cotización registrada", `Se registró la cotización ${v.cotizacion.trim()}\npara el turno ${turno.codigo}.`, "cian");
  }
}

function siguiente() {
  return ejecutar(async () => {
    if (!estado || !estado.espera.length) {
      await aviso("Sin turnos", "No hay turnos en espera para atender.");
      return;
    }

    let empleado = null;
    if (estado.ajustes.empleado_obligatorio && !estado.siguiente_empleado_pendiente) {
      const v = await formulario({
        titulo: "👤 Empleado que Atiende",
        color: "verde",
        descripcion: "Este empleado atenderá el siguiente turno:",
        campos: [
          { name: "empleado", placeholder: "Ej: VEN 02, T 001...", maxlength: 60, grande: true, valor: $("#input-empleado").value.trim() },
        ],
        aceptar: "✅ Llamar Turno",
        validar: (val) => (val.empleado.trim() ? null : "❌ Debes ingresar el número de empleado"),
      });
      if (!v) return;
      empleado = v.empleado.trim();
      $("#input-empleado").value = empleado;
      guardarLS(LS_EMP, empleado);
    }

    const r = await api("/api/siguiente", { method: "POST", body: { empleado } });
    aplicar(r.estado);

    if (r.estado.ajustes.cotizacion_activa) {
      await solicitarCotizacion(r.turno, false);
    }
  });
}

function devolverTurno() {
  return ejecutar(async () => {
    if (!estado || !estado.atencion.length) {
      await aviso("Sin turnos", "No hay turnos en atención para devolver.");
      return;
    }
    const ok = await confirmar({
      titulo: "⚠️ Confirmar devolución",
      mensaje: `¿Estás seguro de devolver el turno ${estado.actual.codigo} a la cola de espera?\n\nEl turno volverá al inicio de la lista de espera.`,
    });
    if (!ok) return;
    const r = await api("/api/devolver", { method: "POST" });
    aplicar(r.estado);
  });
}

function cotizacionManual() {
  return ejecutar(async () => {
    if (!estado || !estado.actual) {
      await aviso("Sin turnos", "No hay turnos en atención para registrar cotización.");
      return;
    }
    const t = estado.actual;
    if (t.cotizacion) {
      await aviso(
        "✅ Cotización ya registrada",
        `El turno ${t.codigo} ya tiene una cotización registrada:\n\nCotización: ${t.cotizacion}\nEmpleado: ${t.empleado || "(sin empleado)"}\n\nNo se puede registrar una nueva cotización para este turno.`,
        "cian"
      );
      return;
    }
    await solicitarCotizacion(t, true);
  });
}

function limpiar(tipo) {
  const espera = tipo === "espera";
  return ejecutar(async () => {
    const base = `/api/limpiar/${tipo}`;
    const prev = await api(base, { method: "POST", body: { validar: true } });
    const ok = await confirmar({
      titulo: "⚠️ Confirmar limpieza",
      mensaje: espera
        ? `Se eliminarán los ${prev.total} turno(s) en espera.\n\n¿Deseas continuar?`
        : `Se eliminarán los ${prev.total} turno(s) en atención.\n\nLos tiempos de atención se registrarán hasta este momento.\n\n¿Deseas continuar?`,
    });
    if (!ok) return;
    const r = await api(base, { method: "POST", body: {} });
    aplicar(r.estado);
    await aviso(
      "Limpieza completada",
      `✅ Se han eliminado ${r.total} turno(s) ${espera ? "de la cola de espera" : "de atención"}.`,
      "verde"
    );
  });
}
const limpiarEspera = () => limpiar("espera");
const limpiarAtencion = () => limpiar("atencion");

function alternarEmpleado() {
  return ejecutar(async () => {
    const c = await pedirCredenciales("cambiar el modo de empleado", false);
    if (!c) return;
    const r = await api("/api/ajustes/empleado", { method: "POST", body: { usuario: c.usuario, password: c.password } });
    aplicar(r.estado);

    let msg = "";
    if (r.pendientes_borrados > 0) {
      msg += `Se han eliminado ${r.pendientes_borrados} empleado(s) en memoria que estaban asociados a turnos devueltos.\n\nLos próximos turnos que se atiendan solicitarán un nuevo número de empleado (según el modo actual).\n\n`;
    }
    msg += r.estado.ajustes.empleado_obligatorio
      ? "🔒 Modo OBLIGATORIO activado.\nSe pedirá número de empleado cada vez que llames un turno."
      : "🔓 Modo OPCIONAL activado.\nNo se pedirá número de empleado al llamar turnos.";
    await aviso("Modo Empleado", msg, "morado");
  });
}

function alternarCotizacion() {
  return ejecutar(async () => {
    const c = await pedirCredenciales("cambiar el modo de cotización", false);
    if (!c) return;
    const r = await api("/api/ajustes/cotizacion", { method: "POST", body: { usuario: c.usuario, password: c.password } });
    aplicar(r.estado);
    await aviso(
      "Modo Cotización",
      r.estado.ajustes.cotizacion_activa
        ? "📝 Cotización ON activado.\nAl atender cada turno se solicitará automáticamente los últimos 6 dígitos de la cotización generada."
        : "📝 Cotización OFF desactivado.\nNo se solicitará cotización al atender turnos.",
      "cian"
    );
  });
}

function cambiarClave() {
  return ejecutar(async () => {
    const c = await pedirCredenciales("cambiar la contraseña", false);
    if (!c) return;

    const v = await formulario({
      titulo: "🔑 Cambiar Contraseña",
      color: "naranja",
      campos: [
        { name: "rol", label: "Cuenta:", tipo: "select", opciones: [["admin", "👑 Administrador"], ["sub_admin", "🔧 Sub-Administrador"]] },
        { name: "actual", label: "Contraseña actual:", tipo: "password", placeholder: "Contraseña actual", autocomplete: "off" },
        { name: "nueva", label: "Nueva contraseña:", tipo: "password", placeholder: "Nueva contraseña (mín. 6 caracteres)", autocomplete: "new-password" },
        { name: "confirmar", label: "Confirmar:", tipo: "password", placeholder: "Confirmar nueva contraseña", autocomplete: "new-password" },
      ],
      aceptar: "💾 Guardar",
      validar: async (val) => {
        try {
          await api("/api/password", {
            method: "POST",
            body: { usuario: c.usuario, password: c.password, rol: val.rol, actual: val.actual, nueva: val.nueva, confirmar: val.confirmar },
          });
          return null;
        } catch (e) {
          return "❌ " + e.message;
        }
      },
    });
    if (v) await aviso("Contraseña actualizada", "✅ La contraseña se ha cambiado correctamente.", "verde");
  });
}

function reiniciar() {
  return ejecutar(async () => {
    await api("/api/reiniciar", { method: "POST", body: { validar: true } });
    const c = await pedirCredenciales("reiniciar el contador de turnos", true);
    if (!c) return;
    const ok = await confirmar({
      titulo: "🔄 Confirmar Reinicio",
      mensaje:
        "¿Reiniciar el contador de turnos a 0?\n\nSe reiniciará:\n• Contador de turnos generados → 0\n\nNO se borrarán:\n• Total de turnos atendidos\n• Total de turnos limpiados\n• Historial de atenciones\n• Estadísticas de tiempo\n\nEsta acción no se puede deshacer.",
    });
    if (!ok) return;
    const r = await api("/api/reiniciar", { method: "POST", body: { usuario: c.usuario, password: c.password } });
    aplicar(r.estado);
    await aviso("✅ Reinicio Completado", "El contador de turnos ha sido reiniciado a 0.\nLas estadísticas acumuladas permanecen intactas.", "verde");
  });
}

function cerrarSesion() {
  return ejecutar(async () => {
    const c = await pedirCredenciales("cerrar la sesión", true);
    if (!c) return;
    const ok = await confirmar({
      titulo: "🏁 Cerrar sesión",
      color: "rojo",
      mensaje:
        "¿Cerrar la sesión actual?\n\nSe guardará el resumen en el historial y el contador de turnos volverá a 0. Los turnos que sigan en espera o en atención se darán por cerrados.\n\nEsta acción no se puede deshacer.",
    });
    if (!ok) return;
    const r = await api("/api/sesion/cerrar", { method: "POST", body: { usuario: c.usuario, password: c.password } });
    aplicar(r.estado);
    await dialogo({
      titulo: "📊 Resumen de la Sesión",
      color: "azul",
      clase: "ancho",
      contenido: [tablaPares(r.resumen)],
      botones: [{ texto: "Cerrar", clase: "azul", valor: true }],
    });
  });
}

async function mostrarHistorial() {
  return ejecutar(async () => {
    const { sesiones } = await api("/api/historial");
    let contenido;
    if (!sesiones.length) {
      contenido = [el("p", "dlg-desc", "No hay sesiones registradas todavía.")];
    } else {
      const cols = [
        ["ID Sesión", "id_sesion"], ["Inicio", "fecha_inicio"], ["Cierre", "fecha_cierre"],
        ["Generados", "total_generados"], ["Atendidos", "total_atendidos"],
        ["En Espera", "en_espera_al_cerrar"], ["Limpiados", "total_limpiados"],
        ["T. Promedio Atención", "tiempo_promedio_atencion"], ["T. Máx. Atención", "tiempo_maximo_atencion"],
      ];
      const t = el("table", "tabla hist");
      const thead = el("thead");
      const trh = el("tr");
      cols.forEach(([titulo]) => trh.append(el("th", null, titulo)));
      trh.append(el("th", null, "Empleados Activos"));
      thead.append(trh);
      const tb = el("tbody");
      sesiones.forEach((s) => {
        const tr = el("tr");
        cols.forEach(([, k]) => tr.append(el("td", null, s[k] === undefined || s[k] === null ? "—" : String(s[k]))));
        const emps = Object.entries(s.turnos_por_empleado || {}).map(([k, v]) => `Emp ${k}: ${v}`).join(", ");
        tr.append(el("td", null, emps || "—"));
        tb.append(tr);
      });
      t.append(thead, tb);
      contenido = [envolver(t)];
    }
    await dialogo({
      titulo: "📜 Historial de Sesiones",
      color: "naranja",
      clase: "ancho",
      contenido,
      botones: [{ texto: "Cerrar", clase: "azul", valor: true }],
    });
  });
}

/* ---------------- Lista completa (espera / atención) ---------------- */
function abrirLista(tipo) {
  const espera = tipo === "espera";
  const color = espera ? "azul" : "verde";
  let seleccion = null;

  const instr = el("p", "dlg-desc", "💡 Selecciona un turno y presiona Retroceso (Backspace) para eliminarlo");
  const tabla = el("table", "tabla");
  const thead = el("thead");
  const trh = el("tr");
  ["#", "Turno", "Empleado", "Posición"].forEach((x) => trh.append(el("th", null, x)));
  thead.append(trh);
  const tbody = el("tbody");
  tabla.append(thead, tbody);
  const contador = el("div", "dlg-contador");

  function items() {
    return estado ? (espera ? estado.espera : estado.atencion) : [];
  }

  function pintar() {
    const lista = items();
    if (!lista.some((t) => t.id === seleccion)) seleccion = null;
    tbody.replaceChildren();
    lista.forEach((t, i) => {
      const tr = el("tr", t.id === seleccion ? "sel" : "");
      tr.append(
        el("td", null, String(i + 1)),
        el("td", "codigo", t.codigo),
        el("td", null, espera ? "—" : t.empleado || "—"),
        el("td", null, `${i + 1} de ${lista.length}`)
      );
      tr.addEventListener("click", () => { seleccion = t.id; pintar(); });
      tbody.append(tr);
    });
    contador.textContent = `Total: ${lista.length} turno(s)`;
  }

  function eliminar() {
    return ejecutar(async () => {
      if (seleccion === null) {
        await aviso("Sin selección", "Selecciona un turno de la lista para eliminarlo.", color);
        return;
      }
      const t = items().find((x) => x.id === seleccion);
      if (!t) return;
      const ok = await confirmar({ titulo: "Confirmar eliminación", mensaje: `¿Eliminar el turno ${t.codigo}?` });
      if (!ok) return;
      const r = await api(`/api/turnos/${t.id}`, { method: "DELETE" });
      const idx = items().findIndex((x) => x.id === t.id);
      aplicar(r.estado);
      const lista = items();
      if (lista.length) seleccion = lista[Math.min(idx, lista.length - 1)].id;
      pintar();
    });
  }

  listaActiva = { pintar };
  dialogo({
    titulo: espera ? "📋 Lista Completa de Turnos en Espera" : "📋 Lista Completa de Turnos en Atención",
    color,
    clase: "ancho",
    contenido: [instr, envolver(tabla), contador],
    botones: [
      { texto: "🗑️ Eliminar seleccionado", clase: "rosa", onClick: () => eliminar() },
      { texto: "Cerrar", clase: color, valor: true },
    ],
    onMontar: (ctl) => {
      ctl.dlg.addEventListener("keydown", (ev) => {
        if (ev.key === "Backspace") { ev.preventDefault(); eliminar(); }
      });
      pintar();
    },
  }).then(() => { listaActiva = null; });
}

/* ---------------- Eventos ---------------- */
function init() {
  const guardado = leerLS(LS_EMP);
  if (guardado) $("#input-empleado").value = guardado;
  $("#input-empleado").addEventListener("input", (ev) => {
    guardarLS(LS_EMP, ev.target.value.trim());
    actualizarEtiquetaEmpleado();
  });

  $("#btn-nuevo").addEventListener("click", nuevoTurno);
  $("#btn-lista-espera").addEventListener("click", () => abrirLista("espera"));
  $("#btn-limpiar-espera").addEventListener("click", limpiarEspera);

  $("#btn-siguiente").addEventListener("click", siguiente);
  $("#btn-anterior").addEventListener("click", devolverTurno);
  $("#btn-lista-atencion").addEventListener("click", () => abrirLista("atencion"));
  $("#btn-limpiar-atencion").addEventListener("click", limpiarAtencion);

  $("#btn-toggle-empleado").addEventListener("click", alternarEmpleado);
  $("#btn-toggle-cotizacion").addEventListener("click", alternarCotizacion);
  $("#btn-cotizar").addEventListener("click", cotizacionManual);
  $("#btn-reiniciar").addEventListener("click", reiniciar);
  $("#btn-historial").addEventListener("click", mostrarHistorial);
  $("#btn-cerrar-sesion").addEventListener("click", cerrarSesion);
  $("#btn-clave").addEventListener("click", cambiarClave);
  $("#btn-pantalla").addEventListener("click", () => window.open("/?modo=pantalla", "_blank"));

  // Atajos: Alt+letra (Ctrl+N/L/K... los reservan los navegadores) y Retroceso.
  document.addEventListener("keydown", (ev) => {
    if (MODO_PANTALLA) return;
    if (document.querySelector("dialog[open]")) return;

    const tag = (ev.target.tagName || "").toLowerCase();
    const escribiendo = tag === "input" || tag === "textarea" || tag === "select" || ev.target.isContentEditable;

    if (ev.key === "Backspace" && !escribiendo && !ev.altKey && !ev.ctrlKey && !ev.metaKey) {
      ev.preventDefault();
      devolverTurno();
      return;
    }
    if (!ev.altKey || ev.ctrlKey || ev.metaKey) return;

    const mapa = {
      KeyN: nuevoTurno,
      KeyS: siguiente,
      KeyA: devolverTurno,
      KeyL: limpiarEspera,
      KeyK: limpiarAtencion,
      KeyC: cotizacionManual,
    };
    const fn = mapa[ev.code];
    if (fn) { ev.preventDefault(); fn(); }
  });

  // Doble clic en el modo pantalla: pantalla completa.
  document.addEventListener("dblclick", () => {
    if (!MODO_PANTALLA) return;
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => {});
  });

  refrescar();
  setInterval(refrescar, 2000);
}

init();
