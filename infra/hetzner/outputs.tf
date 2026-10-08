output "instance_name" {
  value = hcloud_server.ctf.name
}

output "external_ip" {
  value = hcloud_server.ctf.ipv4_address
}

output "webapp_url" {
  value       = "http://127.0.0.1:8000"
  description = "Open locally after forwarding SSH port 8000 to the VM."
}
