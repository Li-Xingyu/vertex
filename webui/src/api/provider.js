import axios from 'axios';
async function call (action, body) {
  const res = body === undefined ? await axios.get('/api/provider/' + action) : await axios.post('/api/provider/' + action, body, { headers: { 'X-Vertex-Config': '1' }, validateStatus: () => true });
  if (!res.data.success) throw new Error(res.data.message || '采集接口不可用');
  return res.data.data;
}
export default { call };
