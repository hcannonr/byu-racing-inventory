export type Role = 'member' | 'buyer' | 'admin';
export type MemberStatus = 'pending' | 'approved' | 'revoked';
export interface Actor { userId: string; email: string; role: Role }
export interface Member { id: string; email: string; role: Role; status: MemberStatus; revision: number }
export interface SessionView { mode: 'local' | 'deployed'; user?: Member; csrf?: string; reviewPreview?: boolean }
