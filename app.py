"""Turnero web: Flask + PostgreSQL (Neon), listo para Render."""
import os
import re
import threading
import time
from collections import Counter
from zoneinfo import ZoneInfo

from flask import Flask, jsonify, render_template, request
from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError
from werkzeug.exceptions import HTTPException
from werkzeug.middleware.proxy_fix import ProxyFix
from werkzeug.security import check_password_hash, generate_password_hash

from models import Ajustes, Credencial, Sesion, Turno, ahora_utc, db

try:
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:  # python-dotenv es opcional
    pass

# ============================================================
# CONFIGURACIÓN
# ============================================================
TZ_LOCAL = ZoneInfo(os.environ.get("APP_TIMEZONE", "America/Mexico_City"))
MIN_PASSWORD = 6
MAX_PASSWORD = 128
MAX_FALLOS = 5  # intentos de login fallidos permitidos...
VENTANA_FALLOS = 300  # ...dentro de esta ventana (segundos)
ROLES = ("admin", "sub_admin")


def _database_uri():
    url = os.environ.get("DATABASE_URL", "").strip()
    if not url:
        return "sqlite:///turnero_local.db"
    if url.startswith("postgres://"):
        url = "postgresql://" + url[len("postgres://"):]
    if url.startswith("postgresql://"):
        url = "postgresql+psycopg2://" + url[len("postgresql://"):]
    return url


app = Flask(__name__)
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)
app.json.sort_keys = False

_uri = _database_uri()
_opciones = {"pool_pre_ping": True, "pool_recycle": 280}  # Neon suspende conexiones
if not _uri.startswith("sqlite"):
    _opciones.update(pool_size=5, max_overflow=5)
app.config["SQLALCHEMY_DATABASE_URI"] = _uri
app.config["SQLALCHEMY_ENGINE_OPTIONS"] = _opciones
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False
db.init_app(app)


# ============================================================
# UTILIDADES
# ============================================================
class ApiError(Exception):
    def __init__(self, mensaje, status=400):
        super().__init__(mensaje)
        self.mensaje = mensaje
        self.status = status


@app.errorhandler(ApiError)
def _manejar_api_error(e):
    db.session.rollback()
    return jsonify({"error": e.mensaje}), e.status


@app.errorhandler(Exception)
def _manejar_error(e):
    if isinstance(e, HTTPException):
        if request.path.startswith("/api/"):
            return jsonify({"error": e.description}), e.code
        return e
    app.logger.exception("Error no controlado")
    db.session.rollback()
    return jsonify({"error": "Error interno del servidor."}), 500


@app.after_request
def _cabeceras(resp):
    if request.path.startswith("/api/"):
        resp.headers["Cache-Control"] = "no-store"
    resp.headers["X-Content-Type-Options"] = "nosniff"
    return resp


def _aware(dt):
    if dt is None:
        return None
    from datetime import timezone

    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _local(dt, fmt="%d/%m/%Y %H:%M:%S"):
    return _aware(dt).astimezone(TZ_LOCAL).strftime(fmt) if dt else None


def formatear_duracion(segundos):
    h, r = divmod(int(segundos), 3600)
    m, s = divmod(r, 60)
    return f"{h:02d}:{m:02d}:{s:02d}"


def _nuevo_token(ahora):
    return ahora.strftime("%Y%m%d%H%M%S%f")


def _json():
    return request.get_json(silent=True) or {}


def _get_ajustes(lock=False):
    q = select(Ajustes).where(Ajustes.id == 1)
    if lock:
        # Bloquea la fila: serializa todas las operaciones que modifican el estado.
        q = q.with_for_update()
    return db.session.execute(q).scalar_one()


def _contar(estado):
    return (
        db.session.scalar(
            select(func.count()).select_from(Turno).where(Turno.estado == estado)
        )
        or 0
    )


def _primero_en_espera():
    return db.session.scalars(
        select(Turno)
        .where(Turno.estado == "espera")
        .order_by(Turno.orden_espera.asc(), Turno.id.asc())
        .limit(1)
    ).first()


def _turno_actual():
    return db.session.scalars(
        select(Turno)
        .where(Turno.estado == "atencion")
        .order_by(Turno.orden_atencion.desc(), Turno.id.desc())
        .limit(1)
    ).first()


def _cerrar_tiempo(turno, ahora):
    turno.hora_fin = ahora
    turno.duracion_segundos = int((ahora - _aware(turno.hora_llamado)).total_seconds())


def _turno_json(t):
    return {
        "id": t.id,
        "codigo": t.codigo,
        "empleado": t.empleado,
        "cotizacion": t.cotizacion,
    }


def _construir_estado():
    aj = _get_ajustes()
    espera = db.session.scalars(
        select(Turno)
        .where(Turno.estado == "espera")
        .order_by(Turno.orden_espera.asc(), Turno.id.asc())
    ).all()
    atencion = db.session.scalars(
        select(Turno)
        .where(Turno.estado == "atencion")
        .order_by(Turno.orden_atencion.asc(), Turno.id.asc())
    ).all()
    atendidos = (
        db.session.scalar(
            select(func.count())
            .select_from(Turno)
            .where(
                Turno.sesion_token == aj.sesion_token,
                Turno.hora_llamado.is_not(None),
            )
        )
        or 0
    )
    actual = atencion[-1] if atencion else None
    return {
        "espera": [_turno_json(t) for t in espera],
        "atencion": [_turno_json(t) for t in atencion],
        "actual": _turno_json(actual) if actual else None,
        "ultimo_espera": espera[-1].codigo if espera else None,
        "siguiente_empleado_pendiente": espera[0].empleado if espera else None,
        "ajustes": {
            "empleado_obligatorio": aj.empleado_obligatorio,
            "cotizacion_activa": aj.cotizacion_activa,
        },
        "stats": {
            "generados": aj.numero_turno,
            "atendidos": atendidos,
            "limpiados": aj.total_limpiados,
            "espera": len(espera),
            "atencion": len(atencion),
        },
        "sesion_inicio": _local(aj.sesion_inicio, "%d/%m/%Y %H:%M"),
    }


def _ok(**extra):
    return jsonify({"ok": True, **extra, "estado": _construir_estado()})


# ============================================================
# AUTENTICACIÓN (admin / sub_admin) con límite de intentos
# ============================================================
_FALLOS = {}
_FALLOS_LOCK = threading.Lock()


def _verificar_bloqueo(ip):
    ahora = time.time()
    with _FALLOS_LOCK:
        intentos = [t for t in _FALLOS.get(ip, []) if ahora - t < VENTANA_FALLOS]
        if intentos:
            _FALLOS[ip] = intentos
        else:
            _FALLOS.pop(ip, None)
        if len(intentos) >= MAX_FALLOS:
            espera = int(VENTANA_FALLOS - (ahora - intentos[0])) + 1
            raise ApiError(
                f"Demasiados intentos fallidos. Intenta de nuevo en {espera} segundos.",
                429,
            )


def _registrar_fallo(ip):
    with _FALLOS_LOCK:
        _FALLOS.setdefault(ip, []).append(time.time())


def _limpiar_fallos(ip):
    with _FALLOS_LOCK:
        _FALLOS.pop(ip, None)


def autenticar(data, permitir_sub_admin, motivo="esta acción"):
    """Valida usuario/contraseña y devuelve el rol ('admin' o 'sub_admin')."""
    ip = request.remote_addr or "?"
    _verificar_bloqueo(ip)

    usuario = str(data.get("usuario") or "").strip()
    password = str(data.get("password") or "")

    rol_ok = None
    for rol in ROLES:
        cred = db.session.get(Credencial, rol)
        if cred and cred.usuario == usuario and check_password_hash(
            cred.password_hash, password
        ):
            rol_ok = rol
            break

    if rol_ok is None:
        _registrar_fallo(ip)
        raise ApiError("Usuario o contraseña incorrectos, intente de nuevo.", 401)

    if rol_ok == "sub_admin" and not permitir_sub_admin:
        raise ApiError(
            f"El usuario sub_admin no tiene permiso para {motivo}.\n"
            "Solo el administrador puede realizar esta acción.",
            403,
        )

    _limpiar_fallos(ip)
    return rol_ok


# ============================================================
# PÁGINAS
# ============================================================
@app.get("/")
def index():
    return render_template("index.html")


@app.get("/healthz")
def healthz():
    # No toca la base de datos a propósito: así Neon puede suspenderse sin uso.
    return "ok"


# ============================================================
# API: estado y turnos
# ============================================================
@app.get("/api/estado")
def api_estado():
    return jsonify(_construir_estado())


@app.post("/api/turnos")
def crear_turno():
    aj = _get_ajustes(lock=True)
    aj.numero_turno += 1
    maximo = db.session.scalar(
        select(func.max(Turno.orden_espera)).where(Turno.estado == "espera")
    )
    turno = Turno(
        sesion_token=aj.sesion_token,
        codigo=f"T-{aj.numero_turno:03d}",
        estado="espera",
        orden_espera=(maximo if maximo is not None else 0) + 1,
    )
    db.session.add(turno)
    db.session.commit()
    return _ok(turno=_turno_json(turno))


@app.post("/api/siguiente")
def siguiente():
    data = _json()
    aj = _get_ajustes(lock=True)

    primero = _primero_en_espera()
    if primero is None:
        raise ApiError("No hay turnos en espera para atender.", 409)

    empleado = None
    if primero.empleado:
        # Turno devuelto a la espera: conserva el empleado que ya lo atendía.
        empleado = primero.empleado
    elif aj.empleado_obligatorio:
        empleado = str(data.get("empleado") or "").strip()
        if not empleado:
            raise ApiError("Debes ingresar el número de empleado.", 400)
        if len(empleado) > 60:
            raise ApiError("El número de empleado es demasiado largo.", 400)

    ahora = ahora_utc()

    # Cierra el tiempo del turno que estaba en atención.
    anterior = _turno_actual()
    if anterior is not None and anterior.hora_fin is None and anterior.hora_llamado:
        _cerrar_tiempo(anterior, ahora)

    maximo = db.session.scalar(
        select(func.max(Turno.orden_atencion)).where(Turno.estado == "atencion")
    )
    primero.estado = "atencion"
    primero.orden_espera = None
    primero.orden_atencion = (maximo if maximo is not None else 0) + 1
    primero.empleado = empleado
    primero.hora_llamado = ahora
    primero.hora_fin = None
    primero.duracion_segundos = None
    db.session.commit()
    return _ok(turno=_turno_json(primero))


@app.post("/api/devolver")
def devolver():
    _get_ajustes(lock=True)
    actual = _turno_actual()
    if actual is None:
        raise ApiError("No hay turnos en atención para devolver.", 409)

    if actual.hora_llamado:
        _cerrar_tiempo(actual, ahora_utc())

    minimo = db.session.scalar(
        select(func.min(Turno.orden_espera)).where(Turno.estado == "espera")
    )
    actual.estado = "espera"
    actual.orden_atencion = None
    actual.orden_espera = (minimo if minimo is not None else 1) - 1
    db.session.commit()
    return _ok()


@app.delete("/api/turnos/<int:turno_id>")
def eliminar_turno(turno_id):
    _get_ajustes(lock=True)
    turno = db.session.get(Turno, turno_id)
    if turno is None or turno.estado not in ("espera", "atencion"):
        raise ApiError("El turno ya no existe en la lista.", 404)

    if turno.estado == "atencion" or turno.hora_llamado is None:
        db.session.delete(turno)
    else:  # estaba en espera pero ya tiene historial (fue devuelto)
        turno.estado = "cerrado"
        turno.orden_espera = None
    db.session.commit()
    return _ok()


@app.post("/api/turnos/<int:turno_id>/cotizacion")
def registrar_cotizacion(turno_id):
    data = _json()
    _get_ajustes(lock=True)
    turno = db.session.get(Turno, turno_id)
    if turno is None or turno.estado != "atencion":
        raise ApiError("El turno ya no está en atención.", 404)

    if turno.cotizacion:
        raise ApiError(
            f"El turno {turno.codigo} ya tiene una cotización registrada: "
            f"{turno.cotizacion}.",
            409,
        )

    valor = str(data.get("cotizacion") or "").strip()
    if not valor:
        raise ApiError("Debes ingresar los últimos 6 dígitos.", 400)
    if not re.fullmatch(r"[0-9]{6}", valor):
        raise ApiError("Deben ser exactamente 6 dígitos numéricos.", 400)

    turno.cotizacion = valor
    turno.cotizacion_fecha = ahora_utc()
    db.session.commit()
    return _ok(cotizacion=valor, turno=_turno_json(turno))


# ============================================================
# API: limpiezas (con regla de paridad) y reinicio
# ============================================================
@app.post("/api/limpiar/espera")
def limpiar_espera():
    data = _json()
    aj = _get_ajustes(lock=True)

    total = _contar("espera")
    if total == 0:
        raise ApiError("No hay turnos en espera para limpiar.", 409)

    en_atencion = _contar("atencion")
    if en_atencion > 0:
        raise ApiError(
            "No puedes limpiar la espera.\n\n"
            f"🟢 Hay {en_atencion} turno(s) en atención.\n"
            "La ventana de espera NO puede quedarse vacía mientras haya turnos "
            "en atención.\n\n"
            "Primero devuelve o atiende los turnos en atención, "
            "o limpia ambas ventanas simultáneamente.",
            409,
        )

    if data.get("validar"):
        return jsonify({"ok": True, "total": total})

    for t in db.session.scalars(select(Turno).where(Turno.estado == "espera")).all():
        if t.hora_llamado is None:
            db.session.delete(t)
        else:
            t.estado = "cerrado"
            t.orden_espera = None
    aj.total_limpiados += total
    db.session.commit()
    return _ok(total=total)


@app.post("/api/limpiar/atencion")
def limpiar_atencion():
    data = _json()
    aj = _get_ajustes(lock=True)

    total = _contar("atencion")
    if total == 0:
        raise ApiError("No hay turnos en atención para limpiar.", 409)

    en_espera = _contar("espera")
    if en_espera > 0:
        raise ApiError(
            "No puedes limpiar la atención.\n\n"
            f"🔵 Hay {en_espera} turno(s) en espera.\n"
            "No puede vaciarse una ventana mientras la otra tiene turnos "
            "pendientes.\n\n"
            "Primero atiende o devuelve los turnos en espera, "
            "o limpia ambas ventanas simultáneamente.",
            409,
        )

    if data.get("validar"):
        return jsonify({"ok": True, "total": total})

    ahora = ahora_utc()
    for t in db.session.scalars(select(Turno).where(Turno.estado == "atencion")).all():
        if t.hora_fin is None and t.hora_llamado:
            _cerrar_tiempo(t, ahora)
        t.limpiado = True
        t.estado = "cerrado"
        t.orden_atencion = None
    aj.total_limpiados += total
    db.session.commit()
    return _ok(total=total)


@app.post("/api/reiniciar")
def reiniciar():
    data = _json()
    aj = _get_ajustes(lock=True)

    espera = _contar("espera")
    atencion = _contar("atencion")

    if espera != atencion:
        raise ApiError(
            "No se puede reiniciar el sistema.\n\n"
            "Las ventanas deben tener la misma cantidad de turnos:\n"
            f"🔵 Turnos en espera: {espera}\n"
            f"🟢 Turnos en atención: {atencion}\n\n"
            "No puede vaciarse una ventana si la otra tiene turnos.",
            409,
        )
    if espera > 0 or atencion > 0:
        raise ApiError(
            "Para reiniciar, ambas listas deben estar vacías.\n\n"
            f"Actualmente hay {espera} turno(s) en espera y "
            f"{atencion} turno(s) en atención.\n\n"
            "Atiende o devuelve los turnos pendientes antes de reiniciar.",
            409,
        )

    if data.get("validar"):
        return jsonify({"ok": True})

    autenticar(data, permitir_sub_admin=True, motivo="reiniciar el contador de turnos")

    aj.numero_turno = 0
    db.session.commit()
    return _ok()


# ============================================================
# API: ajustes y credenciales
# ============================================================
@app.post("/api/auth/verificar")
def verificar_credenciales():
    data = _json()
    motivo = str(data.get("motivo") or "esta acción")[:80]
    rol = autenticar(data, bool(data.get("permitir_sub_admin")), motivo)
    return jsonify({"ok": True, "rol": rol})


@app.post("/api/ajustes/empleado")
def alternar_empleado():
    data = _json()
    aj = _get_ajustes(lock=True)
    autenticar(data, permitir_sub_admin=False, motivo="cambiar el modo de empleado")

    aj.empleado_obligatorio = not aj.empleado_obligatorio

    # Olvida los empleados asociados a turnos devueltos a la espera.
    pendientes = db.session.scalars(
        select(Turno).where(Turno.estado == "espera", Turno.empleado.is_not(None))
    ).all()
    for t in pendientes:
        t.empleado = None
    db.session.commit()
    return _ok(pendientes_borrados=len(pendientes))


@app.post("/api/ajustes/cotizacion")
def alternar_cotizacion():
    data = _json()
    aj = _get_ajustes(lock=True)
    autenticar(data, permitir_sub_admin=False, motivo="cambiar el modo de cotización")

    aj.cotizacion_activa = not aj.cotizacion_activa
    db.session.commit()
    return _ok()


@app.post("/api/password")
def cambiar_password():
    data = _json()
    autenticar(data, permitir_sub_admin=False, motivo="cambiar la contraseña")

    rol = data.get("rol")
    if rol not in ROLES:
        raise ApiError("Rol inválido.")

    actual = str(data.get("actual") or "")
    nueva = str(data.get("nueva") or "")
    confirmar = str(data.get("confirmar") or "")

    cred = db.session.get(Credencial, rol)
    if cred is None or not check_password_hash(cred.password_hash, actual):
        raise ApiError(f"La contraseña actual de {rol} es incorrecta.")
    if len(nueva) < MIN_PASSWORD:
        raise ApiError(
            f"La nueva contraseña debe tener al menos {MIN_PASSWORD} caracteres."
        )
    if len(nueva) > MAX_PASSWORD:
        raise ApiError("La nueva contraseña es demasiado larga.")
    if nueva != confirmar:
        raise ApiError("Las contraseñas nuevas no coinciden.")
    if nueva == actual:
        raise ApiError("La nueva contraseña debe ser diferente a la actual.")

    cred.password_hash = generate_password_hash(nueva)
    db.session.commit()
    return jsonify({"ok": True})


# ============================================================
# API: sesiones e historial
# ============================================================
def _stats_tiempo(duraciones):
    if not duraciones:
        return {
            "promedio": 0,
            "minimo": 0,
            "maximo": 0,
            "promedio_f": "—",
            "minimo_f": "—",
            "maximo_f": "—",
        }
    prom = sum(duraciones) / len(duraciones)
    return {
        "promedio": prom,
        "minimo": min(duraciones),
        "maximo": max(duraciones),
        "promedio_f": formatear_duracion(prom),
        "minimo_f": formatear_duracion(min(duraciones)),
        "maximo_f": formatear_duracion(max(duraciones)),
    }


@app.post("/api/sesion/cerrar")
def cerrar_sesion():
    """Guarda el resumen de la sesión en el historial y arranca una nueva."""
    data = _json()
    aj = _get_ajustes(lock=True)
    autenticar(data, permitir_sub_admin=True, motivo="cerrar la sesión")

    cierre = ahora_utc()
    token = aj.sesion_token

    sin_fin = db.session.scalars(
        select(Turno).where(
            Turno.sesion_token == token,
            Turno.hora_llamado.is_not(None),
            Turno.duracion_segundos.is_(None),
        )
    ).all()
    for t in sin_fin:
        _cerrar_tiempo(t, cierre)

    registros = db.session.scalars(
        select(Turno)
        .where(Turno.sesion_token == token, Turno.hora_llamado.is_not(None))
        .order_by(Turno.hora_llamado.asc(), Turno.id.asc())
    ).all()

    en_espera = _contar("espera")
    en_atencion = _contar("atencion")
    por_empleado = Counter((t.empleado or "(sin empleado)") for t in registros)
    st = _stats_tiempo(
        [t.duracion_segundos for t in registros if t.duracion_segundos is not None]
    )
    cotizaciones = sum(1 for t in registros if t.cotizacion)
    atendidos = len(registros)

    segundos = int((cierre - _aware(aj.sesion_inicio)).total_seconds())
    id_sesion = _local(cierre, "%Y%m%d_%H%M%S")
    inicio_f = _local(aj.sesion_inicio)
    cierre_f = _local(cierre)
    duracion_f = formatear_duracion(segundos)
    modo_emp = "Obligatorio" if aj.empleado_obligatorio else "Opcional"
    modo_cot = "Activado" if aj.cotizacion_activa else "Desactivado"

    resumen = [
        ["ID de Sesión", id_sesion],
        ["Fecha y Hora de Inicio", inicio_f],
        ["Fecha y Hora de Cierre", cierre_f],
        ["Duración de la Sesión", duracion_f],
        ["Total de Turnos Generados", aj.numero_turno],
        ["Total de Turnos Atendidos", atendidos],
        ["Total de Turnos Limpiados", aj.total_limpiados],
        ["Turnos en Espera al Cerrar", en_espera],
        ["Turnos en Atención al Cerrar", en_atencion],
        ["Empleados que Atendieron", len(por_empleado)],
        ["Modo Empleado", modo_emp],
        ["Modo Cotización", modo_cot],
        ["Cotizaciones Registradas", cotizaciones],
        ["Tiempo Promedio de Atención", st["promedio_f"]],
        ["Tiempo Mínimo de Atención", st["minimo_f"]],
        ["Tiempo Máximo de Atención", st["maximo_f"]],
    ]

    datos = {
        "id_sesion": id_sesion,
        "fecha_inicio": inicio_f,
        "fecha_cierre": cierre_f,
        "duracion": duracion_f,
        "total_generados": aj.numero_turno,
        "total_atendidos": atendidos,
        "total_limpiados": aj.total_limpiados,
        "en_espera_al_cerrar": en_espera,
        "en_atencion_al_cerrar": en_atencion,
        "modo_empleado": modo_emp.lower(),
        "modo_cotizacion": "activo" if aj.cotizacion_activa else "inactivo",
        "cotizaciones_registradas": cotizaciones,
        "turnos_por_empleado": dict(por_empleado),
        "tiempo_promedio_atencion": st["promedio_f"],
        "tiempo_minimo_atencion": st["minimo_f"],
        "tiempo_maximo_atencion": st["maximo_f"],
        "promedio_segundos": st["promedio"],
        "minimo_segundos": st["minimo"],
        "maximo_segundos": st["maximo"],
        "detalle_atenciones": [
            {
                "turno": t.codigo,
                "empleado": t.empleado or "(sin empleado)",
                "hora_llamado": _local(t.hora_llamado, "%H:%M:%S"),
                "hora_fin_atencion": _local(t.hora_fin, "%H:%M:%S"),
                "duracion_segundos": t.duracion_segundos,
                "duracion_formateada": formatear_duracion(t.duracion_segundos)
                if t.duracion_segundos is not None
                else None,
                "limpiado": t.limpiado,
                "cotizacion": t.cotizacion,
                "cotizacion_fecha": _local(t.cotizacion_fecha),
            }
            for t in registros
        ],
    }

    db.session.add(Sesion(id_sesion=id_sesion, datos=datos, cerrada=cierre))

    # Los turnos que seguían en los paneles se dan por cerrados.
    db.session.execute(
        update(Turno)
        .where(Turno.estado.in_(("espera", "atencion")))
        .values(estado="cerrado", orden_espera=None, orden_atencion=None)
    )

    # Nueva sesión.
    aj.numero_turno = 0
    aj.total_limpiados = 0
    aj.sesion_token = _nuevo_token(cierre)
    aj.sesion_inicio = cierre
    db.session.commit()
    return _ok(resumen=resumen)


@app.get("/api/historial")
def historial():
    filas = db.session.scalars(select(Sesion).order_by(Sesion.id.desc()).limit(200)).all()
    return jsonify({"sesiones": [f.datos for f in filas]})


# ============================================================
# INICIALIZACIÓN DE LA BASE DE DATOS
# ============================================================
def _commit_tolerante():
    try:
        db.session.commit()
    except IntegrityError:  # otro proceso lo creó primero
        db.session.rollback()


def inicializar_db():
    db.create_all()

    if db.session.get(Ajustes, 1) is None:
        ahora = ahora_utc()
        db.session.add(Ajustes(id=1, sesion_token=_nuevo_token(ahora), sesion_inicio=ahora))
        _commit_tolerante()

    iniciales = [
        (
            "admin",
            os.environ.get("ADMIN_USER", "admin"),
            os.environ.get("ADMIN_PASSWORD", "admin123"),
        ),
        (
            "sub_admin",
            os.environ.get("SUB_ADMIN_USER", "sub_admin"),
            os.environ.get("SUB_ADMIN_PASSWORD", "sub123"),
        ),
    ]
    for rol, usuario, password in iniciales:
        if db.session.get(Credencial, rol) is None:
            db.session.add(
                Credencial(
                    rol=rol,
                    usuario=usuario,
                    password_hash=generate_password_hash(password),
                )
            )
            _commit_tolerante()


with app.app_context():
    inicializar_db()


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)), debug=True)
