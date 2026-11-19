/**
 * A password box with an eye button that shows or hides what is typed, and a quiet "Caps Lock is on" warning while the box has focus. It takes what a normal input takes
 * (value, onChange, autoComplete, autoFocus ...); `className` is for the input itself and `wrapperClassName` for the box around it.
 */
import React, { useId, useState } from "react";
import { Eye, EyeOff } from 'lucide-react';

type Props = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> & { wrapperClassName?: string };

export const PasswordInput: React.FC<Props> = ({ className = '', wrapperClassName = '', onKeyDown, onKeyUp, onBlur, ...rest }) => {
  const [shown, setShown] = useState(false);
  const [caps, setCaps] = useState(false);
  const note = useId();
  const watch = (e: React.KeyboardEvent<HTMLInputElement>) => { if (typeof e.getModifierState === 'function') setCaps(e.getModifierState('CapsLock')); };
  return (
    <div className={wrapperClassName}>
      <div className="relative">
        <input {...rest} type={shown ? 'text' : 'password'} aria-describedby={caps ? note : rest['aria-describedby']} className={`${className} pr-10`}
          onKeyDown={(e) => { watch(e); onKeyDown?.(e); }} onKeyUp={(e) => { watch(e); onKeyUp?.(e); }} onBlur={(e) => { setCaps(false); onBlur?.(e); }} />
        <button type="button" onClick={() => setShown((s) => !s)} aria-label={shown ? 'Hide password' : 'Show password'} aria-pressed={shown} title={shown ? 'Hide password' : 'Show password'}
          className="absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r text-[#6B6B6B] hover:text-[#171717] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#171717]">
          {shown ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </div>
      {caps && <div id={note} role="status" className="mt-1 text-[11px] font-normal text-[#8F6200]">Caps Lock is on</div>}
    </div>
  );
};
