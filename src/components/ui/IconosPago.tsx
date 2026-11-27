// Iconos de los metodos de pago Efectivo y Yape (imagenes en public/iconos-pago).
// Misma forma de uso que los iconos de lucide-react ({ className }), para
// poder intercambiarlos sin tocar la logica de las pantallas. Son decorativos:
// el nombre del metodo siempre va escrito al lado, por eso alt="".
// Quedan guardados para uso sin internet (la PWA precachea los .png).
import { cx } from '@/utils/format'

interface Props {
  className?: string
}

function IconoImagen({ src, className }: Props & { src: string }) {
  return (
    <img
      src={src}
      alt=""
      aria-hidden="true"
      draggable={false}
      loading="eager"
      decoding="async"
      className={cx('shrink-0 select-none object-contain', className)}
    />
  )
}

export function IconoEfectivo({ className }: Props) {
  return <IconoImagen src="/iconos-pago/efectivo.png" className={className} />
}

export function IconoYape({ className }: Props) {
  return <IconoImagen src="/iconos-pago/yape.png" className={cx('rounded-[22%]', className)} />
}
