<template>
  <div style="font-size: 24px; font-weight: bold;">HTTP 代理</div>
  <a-divider></a-divider>
  <div class="hosts">
    <div style="text-align: left; ">
      <a-input size="small" v-model:value="proxy" placeholder="http://192.168.1.1:8080"/>
      <div style="margin-top: 12px;"></div>
      <a-textarea  v-model:value="domains" type="textarea" :rows="10" placeholder="www.baidu.com"></a-textarea>
      <div style="margin-top: 16px;">
        <a-button type="primary" @click="save">保存</a-button>
      </div>
      <div style="margin-top: 32px;">
          说明: <br>
          1. http proxy 格式为 http://192.168.1.1:8080<br>
          2. 新站点采集器统一使用上述代理，由代理服务决定直连或节点；留空代理地址则直连<br>
          3. 下方域名列表仅用于原有请求，一行一个<br>
          4. 域名需完全匹配, 例: www.baidu.com<br>
          5. 代理设置不支持绕过 Cloudflare 时使用<br>
      </div>
    </div>
  </div>
</template>
<script>
export default {
  data () {
    return {
      proxy: '',
      domains: ''
    };
  },
  methods: {
    isMobile () {
      if (/Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)) {
        return true;
      } else {
        return false;
      }
    },
    async getProxy () {
      try {
        const res = await this.$api().setting.getProxy();
        this.domains = res.data.domains;
        this.proxy = res.data.proxy;
      } catch (e) {
        await this.$message().error(e.message);
      }
    },
    async save () {
      try {
        await this.$api().setting.saveProxy({ proxy: this.proxy, domains: this.domains });
        await this.$message().success('保存成功');
      } catch (e) {
        await this.$message().error(e.message);
      }
    }
  },
  async mounted () {
    this.getProxy();
  }
};
</script>
<style scoped>
.hosts {
  width: 100%;
  max-width: 1440px;
  margin: 0 auto;
}
</style>
