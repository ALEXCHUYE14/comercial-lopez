import { useState } from 'react'
import { Printer, Bluetooth, Check } from 'lucide-react'
import { Sheet } from '@/components/ui/Sheet'
import { Button } from '@/components/ui/Button'
import { useToast } from '@/components/ui/Toast'
import { money, fechaHora, cantidad } from '@/utils/format'
import { BRAND } from '@/config/brand'
import { construirTicketHtml, imprimirTicketHtml, type TicketDatos, type TicketLinea } from '@/utils/ticket'
import { construirTicketEscPos } from '@/utils/escpos'
import { bluetoothDisponible, imprimirPorBluetooth } from '@/utils/bluetoothPrinter'
import type { ItemCarrito, Venta } from '@/types/database'

const ETIQUETA: Record<string, string> = {
  efectivo: 'Efectivo',
  yape: 'Yape',
  fiado: 'Fiado',
}

function precioItem(item: ItemCarrito): number {
  if (item.modalidad === 'caja') return item.producto.precio_venta_caja ?? item.producto.precio_venta
  if (item.modalidad === 'saco') return item.producto.precio_venta_saco ?? item.producto.precio_venta
  return item.producto.precio_venta
}

function etiquetaCantidad(item: ItemCarrito): string {
  // El formato "N kg" solo aplica cuando se vendio a granel suelto
  // (modalidad 'unidad'); por caja o por saco es una cantidad entera.
  if (item.producto.tipo_venta === 'granel' && item.modalidad === 'unidad') {
    return `${cantidad(item.cantidad)} ${item.producto.unidad}`
  }
  return `${item.cantidad}x`
}

interface Props {
  open: boolean
  onClose: () => void
  venta: Venta
  items: ItemCarrito[]
}

export function Receipt({ open, onClose, venta, items }: Props) {
  const toast = useToast()
  const [imprimiendoBt, setImprimiendoBt] = useState(false)

  function datosTicket(): { datos: TicketDatos; lineas: TicketLinea[] } {
    const lineas: TicketLinea[] = items.map((i) => ({
      cantidadTexto: etiquetaCantidad(i),
      nombre: i.producto.nombre,
      tag: i.modalidad === 'caja' ? 'Caja' : i.modalidad === 'saco' ? 'Saco' : undefined,
      montoTexto: money(precioItem(i) * i.cantidad),
    }))
    const datos: TicketDatos = {
      numero: venta.numero,
      creadoEn: venta.creado_en,
      cajeroNombre: venta.cajero_nombre,
      subtotal: venta.subtotal,
      descuento: venta.descuento,
      igv: venta.igv,
      total: venta.total,
      metodo: venta.metodo,
      pagoRecibido: venta.pago_recibido,
      vuelto: venta.vuelto,
      clienteNombre: venta.cliente_nombre,
      anulada: venta.anulada,
    }
    return { datos, lineas }
  }

  // Impresion por cable (o Bluetooth emparejado como impresora del sistema
  // operativo, si el equipo lo permite): usa el dialogo de impresion nativo.
  function imprimir() {
    const { datos, lineas } = datosTicket()
    try {
      imprimirTicketHtml(construirTicketHtml(datos, lineas))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo abrir la ventana de impresión')
    }
  }

  // Impresion por Bluetooth directa (Web Bluetooth), sin pasar por el
  // dialogo del sistema — ver utils/bluetoothPrinter.ts. Solo disponible en
  // Chrome/Edge (Android, Windows, Mac); en Safari/iPhone se avisa al cajero
  // que use la impresion por cable.
  async function imprimirBluetooth() {
    if (!bluetoothDisponible()) {
      toast.error(
        'Este navegador no soporta impresión Bluetooth. Usa Chrome/Edge en Android, Windows o Mac, o imprime por cable.',
      )
      return
    }
    setImprimiendoBt(true)
    try {
      const { datos, lineas } = datosTicket()
      await imprimirPorBluetooth(construirTicketEscPos(datos, lineas))
      toast.exito('Ticket enviado a la impresora Bluetooth')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo imprimir por Bluetooth')
    } finally {
      setImprimiendoBt(false)
    }
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      maxWidth="max-w-sm"
      footer={
        <div className="flex flex-col gap-2">
          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" onClick={imprimir}>
              <Printer className="size-4" /> Imprimir (cable)
            </Button>
            <Button
              variant="outline"
              className="flex-1"
              loading={imprimiendoBt}
              onClick={imprimirBluetooth}
            >
              <Bluetooth className="size-4" /> Bluetooth
            </Button>
          </div>
          <Button variant="secondary" className="w-full" onClick={onClose}>
            Nueva venta
          </Button>
        </div>
      }
    >
      {/* Confirmación */}
      <div className="mb-4 flex flex-col items-center text-center">
        <div className="mb-2 grid size-12 place-items-center rounded-full bg-accent-100">
          <Check className="size-6 text-accent-700" />
        </div>
        <p className="font-display text-lg font-bold text-ink-900">Venta registrada</p>
        <p className="text-sm text-ink-400">Comprobante #{venta.numero}</p>
      </div>

      {/* Vista previa */}
      <div className="rounded-xl border border-dashed border-ink-200 bg-white p-4 font-mono text-[0.75rem] leading-relaxed">
        {/* Cabecera */}
        <div className="mb-2 text-center">
          <p className="text-sm font-black tracking-wide">{BRAND.nombre.toUpperCase()}</p>
          <p className="text-ink-400 text-[0.7rem]">{fechaHora(venta.creado_en)}</p>
          <p className="text-ink-400 text-[0.7rem]">Cajero: {venta.cajero_nombre ?? '-'}</p>
          <p className="font-bold text-[0.75rem]">Ticket N° {venta.numero}</p>
        </div>

        <hr className="my-2 border-ink-400" />

        {/* Items */}
        <div className="space-y-1">
          {items.map((i) => (
            <div key={`${i.producto.id}::${i.modalidad}`} className="flex justify-between gap-2">
              <span className="min-w-0 break-words font-semibold text-ink-800">
                {etiquetaCantidad(i)} {i.producto.nombre}
                {(i.modalidad === 'caja' || i.modalidad === 'saco') && (
                  <span className="ml-1 rounded bg-accent-100 px-1 py-0.5 text-[0.55rem] font-bold uppercase text-accent-700">
                    {i.modalidad === 'caja' ? 'Caja' : 'Saco'}
                  </span>
                )}
              </span>
              <span className="tabular shrink-0 font-bold">
                {money(precioItem(i) * i.cantidad)}
              </span>
            </div>
          ))}
        </div>

        <hr className="my-2 border-dashed border-ink-300" />

        {/* Subtotales */}
        <div className="space-y-0.5 text-ink-600">
          <PreviewRow k="Subtotal" v={money(venta.subtotal)} />
          {venta.descuento > 0 && (
            <PreviewRow k="Descuento" v={'- ' + money(venta.descuento)} />
          )}
          <PreviewRow k="IGV (18%)" v={money(venta.igv)} />
        </div>

        <hr className="my-2 border-ink-400" />

        {/* Total */}
        <div className="flex justify-between font-black text-sm text-ink-900">
          <span>TOTAL</span>
          <span className="tabular">{money(venta.total)}</span>
        </div>

        <hr className="my-2 border-dashed border-ink-300" />

        {/* Pago */}
        <div className="space-y-0.5">
          <div className="flex justify-between font-bold text-ink-800">
            <span>{ETIQUETA[venta.metodo] ?? venta.metodo}</span>
            <span className="tabular">{money(venta.pago_recibido)}</span>
          </div>
          {venta.metodo === 'efectivo' && venta.vuelto > 0 && (
            <PreviewRow k="Vuelto" v={money(venta.vuelto)} />
          )}
          {venta.cliente_nombre && (
            <PreviewRow k="Fiado a" v={venta.cliente_nombre} />
          )}
        </div>

        <hr className="my-2 border-dashed border-ink-300" />
        <p className="text-center text-ink-400">¡Gracias por su compra!</p>
      </div>
    </Sheet>
  )
}

function PreviewRow({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between">
      <span>{k}</span>
      <span className="tabular font-semibold">{v}</span>
    </div>
  )
}
