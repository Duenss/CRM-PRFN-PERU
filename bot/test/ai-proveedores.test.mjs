// Pruebas de selección/orden de proveedores de IA (sin llamar a la red).
import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { proveedoresDisponibles } from '../src/ai.js';

const respaldo = {
  geminiKey: config.geminiKey,
  groqKey: config.groqKey,
  anthropicKey: config.anthropicKey,
  nvidiaKey: config.nvidiaKey,
  aiOrden: config.aiOrden
};

function restaurar() {
  Object.assign(config, respaldo);
}

test('proveedoresDisponibles: AI_ORDEN elige el orden y omite proveedores sin clave', () => {
  try {
    Object.assign(config, { geminiKey: 'g', groqKey: 'q', anthropicKey: '', nvidiaKey: 'n', aiOrden: 'nvidia,groq,gemini,anthropic' });
    const nombres = proveedoresDisponibles().map(([n]) => n);
    assert.deepEqual(nombres, ['NVIDIA', 'Groq', 'Gemini'], 'Anthropic sin clave se omite');
  } finally { restaurar(); }
});

test('proveedoresDisponibles: sin AI_ORDEN mantiene el orden clásico', () => {
  try {
    Object.assign(config, { geminiKey: 'g', groqKey: 'q', anthropicKey: '', nvidiaKey: 'n', aiOrden: '' });
    const nombres = proveedoresDisponibles().map(([n]) => n);
    assert.deepEqual(nombres, ['Gemini', 'Groq', 'NVIDIA']);
  } finally { restaurar(); }
});

test('proveedoresDisponibles: sin claves devuelve lista vacía', () => {
  try {
    Object.assign(config, { geminiKey: '', groqKey: '', anthropicKey: '', nvidiaKey: '', aiOrden: '' });
    assert.deepEqual(proveedoresDisponibles(), []);
  } finally { restaurar(); }
});
