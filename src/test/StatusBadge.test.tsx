import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { StatusBadge } from '../components/StatusBadge'

describe('StatusBadge', () => {
  it('traduz um status conhecido', () => {
    render(<StatusBadge value="past_due" />)
    expect(screen.getByText('Inadimplente')).toBeInTheDocument()
  })

  it('preserva um status desconhecido', () => {
    render(<StatusBadge value="custom_status" />)
    expect(screen.getByText('custom_status')).toBeInTheDocument()
  })
})
