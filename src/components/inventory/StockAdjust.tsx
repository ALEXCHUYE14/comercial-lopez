import { useState } from 'react'
import { ArrowDownToLine, ArrowUpFromLine, Settings2 } from 'lucide-react'
import { Sheet } from '@/components/ui/Sheet'
import { Button } from '@/components/ui/Button'
import { useToast } from '@/components/ui/Toast'
import { supabase } from '@/lib/supabase'
import { cx } from '@/utils/format'
import { funcionNoExiste } from '@/hooks/useMermas'
import type { Producto, TipoMovimiento } from '@/types/database'

interface Props {
  open: boolean
  onClose: () => void
  producto: Producto | null
  onListo: () => void
}

export function StockAdjust({ open, onClose, producto, onListo }: Props) {
  const toast = useToast()
  const [tipo, setTipo] = useState<'entrada' | 'salida' | 'ajuste'>('entrada')
  const [cantidad, setCantidad] = useState('')
  const [motivo, setMotivo] = useState('')
  const [guardando, setGuardando] = useState(false)

  if (!producto) return null

  const tipos = [
    { id: 'entrada' as const, label: 'Entrada', icon: ArrowDownToLine, signo: 1 },
    { id: 'salida' as const, label: 'Salida', icon: ArrowUpFromLine, signo: -1 },
    { id: 'ajuste' as const, label: 'Ajuste', icon: Settings2, signo: 1 },
  ]
  // parseFloat (no parseInt) para admitir decimales en productos a granel (ej. 2.5 kg)
  const cantNum = parseFloat(cantidad) || 0
  const signo = tipos.find((t) => t.id === tipo)!.signo
  const nuevoStock =
    tipo === 'ajuste' ? cantNum : producto.stock_actual + signo * cantNum

  async function ajustar(delta: number, tipoMov: TipoMovimiento) {
    const { error } = await supabase.rpc('ajustar_stock', {
      p_producto_id: producto!.id,
      p_cantidad: delta,
      p_tipo: tipoMov,
      p_motivo: motivo || null,
    })
    if (error) throw new Error(error.message)
  }

  async function aplicar() {
    // "Ajuste" fija el stock real tras un conteo fisico: 0 es un valor
    // legitimo (ej. el conteo revela que no queda nada). Solo se rechaza si
    // el campo esta vacio o es negativo. Entrada/salida si exigen > 0: no
    // tiene sentido registrar un movimiento de "0 unidades".
    if (cantidad.trim() === '' || cantNum < 0) {
      toast.error('Ingresa una cantidad valida.')
      return
    }
    if (tipo !== 'ajuste' && cantNum === 0) {
      toast.error('Ingresa una cantidad valida.')
      return
    }
    if (guardando) return
    setGuardando(true)
    try {
      if (tipo === 'ajuste') {
        // Conteo fisico: fijar_stock calcula la diferencia EN EL SERVIDOR con
        // el stock real del momento. Antes se calculaba aqui con el stock que
        // mostraba la pantalla: si entre medio se vendia algo, el stock final
        // no quedaba igual a lo contado.
        const { error } = await supabase.rpc('fijar_stock', {
          p_producto_id: producto!.id,
          p_stock: cantNum,
          p_motivo: motivo || null,
        })
        if (error && !funcionNoExiste(error)) throw new Error(error.message)
        if (error) {
          // Respaldo si aun no se ejecuto supabase/correccion_compras_stock.sql.
          await ajustar(cantNum - producto!.stock_actual, 'ajuste')
        }
      } else {
        await ajustar(signo * cantNum, tipo)
      }
      toast.exito('Stock actualizado')
      setCantidad('')
      setMotivo('')
      onListo()
      onClose()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Error al ajustar')
    } finally {
      setGuardando(false)
    }
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Movimiento de stock"
      maxWidth="max-w-md"
      footer={
        <Button variant="secondary" className="w-full" loading={guardando} onClick={aplicar}>
          Aplicar movimiento
        </Button>
      }
    >
      <div className="space-y-4">
        <div className="rounded-xl bg-ink-50 px-4 py-3">
          <p className="text-sm font-semibold text-ink-800">{producto.nombre}</p>
          <p className="tabular text-xs text-ink-400">
            Stock actual: {producto.stock_actual} {producto.unidad}
          </p>
        </div>

        <div className="grid grid-cols-3 gap-2">
          {tipos.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setTipo(id)}
              className={cx(
                'flex flex-col items-center gap-1.5 rounded-xl border px-2 py-3 text-xs font-semibold transition focusable',
                tipo === id
                  ? 'border-accent-500 bg-accent-50 text-accent-700'
                  : 'border-ink-200 text-ink-500 hover:border-ink-300',
              )}
            >
              <Icon className="size-5" />
              {label}
            </button>
          ))}
        </div>

        <label className="block">
          <span className="label mb-1.5 block">
            {tipo === 'ajuste' ? 'Stock real (conteo fisico)' : 'Cantidad'}
          </span>
          <input
            type="number"
            inputMode="decimal"
            step={producto.tipo_venta === 'granel' ? 0.001 : 1}
            autoFocus
            className="input tabular text-lg"
            value={cantidad}
            onChange={(e) => setCantidad(e.target.value)}
            placeholder="0"
          />
        </label>

        <label className="block">
          <span className="label mb-1.5 block">Motivo (opcional)</span>
          <input
            className="input"
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
            placeholder="Compra a proveedor, merma, correccion..."
          />
        </label>

        {cantidad.trim() !== '' && (tipo === 'ajuste' ? cantNum >= 0 : cantNum > 0) && (
          <div className="flex items-center justify-between rounded-xl bg-ink-900 px-4 py-3 text-white">
            <span className="text-sm text-white/60">Stock resultante</span>
            <span className="tabular font-display text-lg font-bold">
              {Math.round(Math.max(nuevoStock, 0) * 1000) / 1000} {producto.unidad}
            </span>
          </div>
        )}
      </div>
    </Sheet>
  )
}
