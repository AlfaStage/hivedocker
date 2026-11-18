// Mostra o codigo de vinculo do no, falando com o painel local ja em execucao.
// Uso dentro do container: npm run link
const base = process.env.HIVE_PANEL_URL || `http://127.0.0.1:${process.env.PORT || 8080}`;
const token = process.env.PANEL_TOKEN;

async function main() {
  if (!token) throw new Error('Defina PANEL_TOKEN');
  const deadline = Date.now() + 120000;
  let shown = null;
  while (Date.now() < deadline) {
    const response = await fetch(`${base}/api/link-code`, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(`Painel respondeu ${response.status}`);
    const { data } = await response.json();
    if (data.linked) { console.log('Este aparelho ja esta vinculado.'); return; }
    if (data.userCode && data.userCode !== shown) {
      shown = data.userCode;
      console.log(`\n  CODIGO DE VINCULO: ${data.userCode}`);
      console.log(`  Aprove em: ${data.approveUrl}`);
      console.log(`  Expira em ${data.expiresInSeconds}s — aguardando aprovacao...\n`);
    }
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  console.log('Tempo esgotado. Rode de novo para ver o codigo atual.');
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
