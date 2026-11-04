"""Modelos de base de datos.

En producción se usa PostgreSQL (Neon). Sin DATABASE_URL se usa SQLite local.
"""
from datetime import datetime, timezone

from flask_sqlalchemy import SQLAlchemy

db = SQLAlchemy()


def ahora_utc():
    return datetime.now(timezone.utc)


class Credencial(db.Model):
    """Credenciales de acceso: una fila por rol ('admin' y 'sub_admin')."""

    __tablename__ = "credenciales"

    rol = db.Column(db.String(20), primary_key=True)
    usuario = db.Column(db.String(80), nullable=False)
    password_hash = db.Column(db.String(255), nullable=False)


class Ajustes(db.Model):
    """Estado global del turnero. Siempre existe una sola fila (id = 1)."""

    __tablename__ = "ajustes"

    id = db.Column(db.Integer, primary_key=True)
    empleado_obligatorio = db.Column(db.Boolean, nullable=False, default=True)
    cotizacion_activa = db.Column(db.Boolean, nullable=False, default=False)
    numero_turno = db.Column(db.Integer, nullable=False, default=0)
    total_limpiados = db.Column(db.Integer, nullable=False, default=0)
    sesion_token = db.Column(db.String(32), nullable=False)
    sesion_inicio = db.Column(
        db.DateTime(timezone=True), nullable=False, default=ahora_utc
    )


class Turno(db.Model):
    """Un turno y su historial de atención.

    estado: 'espera' | 'atencion' | 'cerrado' (ya no aparece en los paneles,
    pero se conserva para las estadísticas de la sesión).
    """

    __tablename__ = "turnos"

    id = db.Column(db.Integer, primary_key=True)
    sesion_token = db.Column(db.String(32), nullable=False, index=True)
    codigo = db.Column(db.String(20), nullable=False)
    estado = db.Column(db.String(10), nullable=False, index=True)
    orden_espera = db.Column(db.Integer)
    orden_atencion = db.Column(db.Integer)
    empleado = db.Column(db.String(60))
    hora_llamado = db.Column(db.DateTime(timezone=True))
    hora_fin = db.Column(db.DateTime(timezone=True))
    duracion_segundos = db.Column(db.Integer)
    cotizacion = db.Column(db.String(6))
    cotizacion_fecha = db.Column(db.DateTime(timezone=True))
    limpiado = db.Column(db.Boolean, nullable=False, default=False)
    creado = db.Column(db.DateTime(timezone=True), nullable=False, default=ahora_utc)


class Sesion(db.Model):
    """Resumen de una sesión cerrada (alimenta el historial)."""

    __tablename__ = "sesiones"

    id = db.Column(db.Integer, primary_key=True)
    id_sesion = db.Column(db.String(32), unique=True, nullable=False)
    datos = db.Column(db.JSON, nullable=False)
    cerrada = db.Column(db.DateTime(timezone=True), nullable=False, default=ahora_utc)
