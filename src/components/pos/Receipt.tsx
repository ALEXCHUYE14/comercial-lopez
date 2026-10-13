import { useState } from 'react'
import { Printer, Bluetooth, Check } from 'lucide-react'
import { Sheet } from '@/components/ui/Sheet'
import { Button } from '@/components/ui/Button'
import { useToast } from '@/components/ui/Toast'
import { money, fechaHora, cantidad } from '@/utils/format'
import { etiquetaModalidadDe, precioPresentacion } from '@/utils/presentaciones'
import { admiteVuelto, lineasPago, metodoParaQr } from '@/utils/pagos'
import { useNegocio, textoDocumento } from '@/config/negocio'
import { construirTicketHtml, imprimirTicketHtml, type TicketDatos, type TicketLinea } from '@/utils/ticket'
import { construirTicketEscPos } from '@/utils/escpos'
import { bluetoothDisponible, imprimirPorBluetooth } from '@/utils/bluetoothPrinter'
import { qrParaTicket } from '@/utils/qrTermico'
import type { ItemCarrito, Venta } from '@/types/database'

const ETIQUETA: Record<string, string> = {
  efectivo: 'Efectivo',
  yape: 'Yape',
  fiado: 'Fiado',
  mixto: 'Mixto',
}

function precioItem(item: ItemCarrito): number {
  if (item.modalidad === 'caja') return item.producto.precio_venta_caja ?? item.producto.precio_venta
  if (item.modalidad === 'saco') return item.producto.precio_venta_saco ?? item.producto.precio_venta
  return precioPresentacion(item.producto, item.modalidad)
}

// Cantidad para el ticket, que la muestra como "2 x S/ 3.50". El formato
// "N kg" solo aplica cuando se vendio a granel suelto (modalidad 'unidad');
// por caja o por saco es una cantidad entera.
function cantidadTicket(item: ItemCarrito): string {
  if (item.producto.tipo_venta === 'granel' && item.modalidad === 'unidad') {
    return `${cantidad(item.cantidad)} ${item.producto.unidad}`
  }
  return cantidad(item.cantidad)
}

interface Props {
  open: boolean
  onClose: () => void
  venta: Venta
  items: ItemCarrito[]
}

export function Receipt({ open, onClose, venta, items }: Props) {
  const toast = useToast()
  const negocio = useNegocio()
  const [imprimiendoBt, setImprimiendoBt] = useState(false)
  const [imprimiendoCable, setImprimiendoCable] = useState(false)

  function datosTicket(): { datos: TicketDatos; lineas: TicketLinea[] } {
    const lineas: TicketLinea[] = items.map((i) => ({
      cantidadTexto: cantidadTicket(i),
      nombre: i.producto.nombre,
      tag: etiquetaModalidadDe(i.producto, i.modalidad),
      precioUnitarioTexto: money(precioItem(i)),
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
      pagos: venta.pagos ?? null,
      clienteNombre: venta.cliente_nombre,
      anulada: venta.anulada,
    }
    return { datos, lineas }
  }

  // Impresion por cable (o Bluetooth emparejado como impresora del sistema
  // operativo, si el equipo lo permite): usa el dialogo de impresion nativo.
  async function imprimir() {
    const { datos, lineas } = datosTicket()
    setImprimiendoCable(true)
    try {
      const { qr, fallo } = await qrParaTicket(metodoParaQr(datos.metodo, datos.pagos), datos.anulada)
      if (fallo) toast.info('No se pudo cargar el QR de Yape: el ticket se imprime sin QR.')
      imprimirTicketHtml(construirTicketHtml(datos, lineas, qr))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo abrir la ventana de impresión')
    } finally {
      setImprimiendoCable(false)
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
      const { qr, fallo } = await qrParaTicket(metodoParaQr(datos.metodo, datos.pagos), datos.anulada)
      if (fallo) toast.info('No se pudo cargar el QR de Yape: el ticket se imprime sin QR.')
      await imprimirPorBluetooth(construirTicketEscPos(datos, lineas, qr))
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
            <Button variant="outline" className="flex-1" loading={imprimiendoCable} onClick={imprimir}>
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
        <p className="text-sm text-ink-400">
          {venta.numero > 0 ? `Comprobante #${venta.numero}` : 'Pendiente de sincronizar'}
        </p>
      </div>

      {/* Vista previa */}
      {/* Mismo formato que el ticket impreso (utils/ticket.ts): todo en negro
          y negrita, sin grises tenues. */}
      <div className="rounded-xl border border-dashed border-ink-300 bg-white p-4 font-sans text-sm font-semibold leading-snug text-black">
        {/* Cabecera */}
        <div className="mb-2 text-center">
          <p className="break-words text-base font-black">{negocio.nombre.toUpperCase()}</p>
          {textoDocumento(negocio) && <p className="text-[0.8rem]">{textoDocumento(negocio)}</p>}
          {negocio.direccion && <p className="break-words text-[0.8rem]">{negocio.direccion}</p>}
          <p className="mx-auto mt-1.5 inline-block border-2 border-black px-2.5 py-0.5 font-black">
            {venta.numero > 0 ? `TICKET N° ${venta.numero}` : 'TICKET (pendiente de sincronizar)'}
          </p>
          <p className="mt-1 text-[0.8rem]">{fechaHora(venta.creado_en)}</p>
          <p className="break-words text-[0.8rem]">Cajero: {venta.cajero_nombre ?? '-'}</p>
        </div>

        <hr className="my-2 border-t-2 border-black" />
        <div className="mb-1.5 flex justify-between text-[0.7rem] font-black tracking-wide">
          <span>DESCRIPCIÓN</span>
          <span>IMPORTE</span>
        </div>

        {/* Items */}
        <div className="space-y-2">
          {items.map((i) => (
            <div key={`${i.producto.id}::${i.modalidad}`}>
              <p className="break-words font-bold">
                {i.producto.nombre}
                {etiquetaModalidadDe(i.producto, i.modalidad) && (
                  <span className="ml-1 text-[0.7rem] font-black uppercase">
                    [{etiquetaModalidadDe(i.producto, i.modalidad)}]
                  </span>
                )}
              </p>
              <div className="flex justify-between gap-2 pl-2">
                <span className="tabular min-w-0">
                  {cantidadTicket(i)} x {money(precioItem(i))}
                </span>
                <span className="tabular shrink-0 font-black">
                  {money(precioItem(i) * i.cantidad)}
                </span>
              </div>
            </div>
          ))}
        </div>

        <hr className="my-2 border-dashed border-black" />

        {/* Subtotales */}
        <div className="space-y-0.5">
          <PreviewRow k="Subtotal" v={money(venta.subtotal)} />
          {venta.descuento > 0 && (
            <PreviewRow k="Descuento" v={'- ' + money(venta.descuento)} />
          )}
          <PreviewRow k="IGV (18%)" v={money(venta.igv)} />
        </div>

        {/* Total */}
        <div className="my-2 flex justify-between border-y-2 border-black py-1.5 text-lg font-black">
          <span>TOTAL</span>
          <span className="tabular">{money(venta.total)}</span>
        </div>

        {/* Pago */}
        <div className="space-y-0.5 font-black">
          {lineasPago(
            { metodo: venta.metodo, pagoRecibido: venta.pago_recibido, vuelto: venta.vuelto, pagos: venta.pagos },
            (m) => ETIQUETA[m] ?? m,
          ).map((l) => (
            <PreviewRow key={l.etiqueta} k={l.etiqueta} v={money(l.monto)} />
          ))}
          {admiteVuelto(venta.metodo) && venta.vuelto > 0 && (
            <PreviewRow k="Vuelto" v={money(venta.vuelto)} />
          )}
          {venta.cliente_nombre && (
            <PreviewRow k="Fiado a" v={venta.cliente_nombre} />
          )}
        </div>

        <div className="mt-2.5 border-t border-dashed border-black pt-2 text-center text-[0.8rem]">
          <p>¡Gracias por su compra!</p>
          <p>Vuelva pronto</p>
        </div>
      </div>
    </Sheet>
  )
}

function PreviewRow({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="min-w-0 break-words">{k}</span>
      <span className="tabular max-w-[65%] shrink-0 break-words text-right">{v}</span>
    </div>
  )
}
