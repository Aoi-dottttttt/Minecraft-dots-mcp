extends Node3D
# Native file-only reconstruction. No HTTP, sockets, game controls or writeback.
const MAX_BYTES = 16 * 1024 * 1024
const MAX_VERTICES = 150000
var directory = ""
var atlas_path = ""
var camera: Camera3D
var world: Node3D
var label: Label
var stale_cover: ColorRect
var stale_label: Label
var material: StandardMaterial3D
var deadline = 0.0
var poll_at = 0.0
var last_digest = ""
var orbit = 0.65
var elevation = 0.55
var distance = 24.0
var focus = Vector3.ZERO
var is_live = false
var vertex_count = 0
var last_generation = -1
var last_sequence = -1
var test_frames = 0
var frame_counter = 0
var synthetic = false
var last_stale_message = ""
var verify_pixels = false
var pixel_busy = false
var saw_live_pixels = false
var saw_geometry_change = false
var first_pixel_vertices = 0
var pixel_started = 0

func _ready():
	get_window().title = "Minecraft - Native Read-only 3D Reconstruction"
	Engine.max_fps = 15
	var args = OS.get_cmdline_user_args()
	synthetic = args.has("--synthetic-fixture")
	verify_pixels = args.has("--verify-pixels")
	pixel_started = Time.get_ticks_msec()
	if verify_pixels and not synthetic: get_tree().quit(1); return
	for i in range(args.size()):
		if args[i] == "--directory" and i + 1 < args.size(): directory = args[i + 1]
		if args[i] == "--atlas" and i + 1 < args.size(): atlas_path = args[i + 1]
		if args[i] == "--test-frames" and i + 1 < args.size(): test_frames = int(args[i + 1])
	world = Node3D.new(); add_child(world)
	camera = Camera3D.new(); camera.fov = 55; camera.near = 0.05; camera.far = 150; add_child(camera)
	var layer = CanvasLayer.new(); add_child(layer)
	label = Label.new(); label.position = Vector2(18, 14); label.add_theme_font_size_override("font_size", 17); layer.add_child(label)
	stale_cover = ColorRect.new(); stale_cover.color = Color(0.025, 0.035, 0.045, 1); stale_cover.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT); layer.add_child(stale_cover)
	stale_label = Label.new(); stale_label.position = Vector2(32, 84); stale_label.add_theme_font_size_override("font_size", 24); stale_cover.add_child(stale_label)
	mark_stale("Waiting for a fresh, bounded world file")
	if not directory.is_absolute_path() or not atlas_path.is_absolute_path():
		mark_stale("Explicit local data directory and installed texture atlas required"); return
	var img = Image.new()
	if img.load(atlas_path) != OK or img.get_width() > 8192 or img.get_height() > 8192:
		mark_stale("Official texture atlas unavailable"); return
	material = StandardMaterial3D.new()
	material.albedo_texture = ImageTexture.create_from_image(img)
	material.vertex_color_use_as_albedo = true
	material.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	material.texture_filter = BaseMaterial3D.TEXTURE_FILTER_NEAREST
	material.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA_SCISSOR
	material.alpha_scissor_threshold = 0.1
	# Preserve original indexed topology without changing its winding convention.
	material.cull_mode = BaseMaterial3D.CULL_DISABLED
	poll_frame()

func finite(value):
	return (typeof(value) == TYPE_FLOAT or typeof(value) == TYPE_INT) and is_finite(float(value))

func triple(value, limit):
	return value is Array and value.size() == 3 and finite(value[0]) and finite(value[1]) and finite(value[2]) and abs(value[0]) <= limit and abs(value[1]) <= limit and abs(value[2]) <= limit

func point(value):
	return value is Dictionary and finite(value.get("x")) and finite(value.get("y")) and finite(value.get("z")) and abs(value.x) <= 30000000 and abs(value.y) <= 2048 and abs(value.z) <= 30000000

func stamp(value):
	if not value is String or value.length() < 20 or value.length() > 30 or not value.ends_with("Z"): return -1.0
	return float(Time.get_unix_time_from_datetime_string(value.split(".")[0].trim_suffix("Z")))

func array_numbers(value, count, limit):
	if not value is Array or value.size() != count: return false
	for entry in value:
		if not finite(entry) or abs(entry) > limit: return false
	return true

func valid_frame(frame):
	if not frame is Dictionary or frame.get("schemaVersion") != 1 or frame.get("bounded") != true or frame.get("status") != "live": return false
	var now = Time.get_unix_time_from_system()
	var captured = stamp(frame.get("capturedAt")); var until = stamp(frame.get("validUntil"))
	if captured <= 0 or captured > now + 1 or until <= now or until < captured or until - captured > 5: return false
	if not point(frame.get("position")) or not finite(frame.get("sourceGeneration")) or not finite(frame.get("sourceSequence")): return false
	if frame.sourceGeneration < 0 or frame.sourceSequence < 0 or frame.sourceGeneration > 9007199254740991 or frame.sourceSequence > 9007199254740991 or frame.sourceGeneration != int(frame.sourceGeneration) or frame.sourceSequence != int(frame.sourceSequence): return false
	if not frame.get("sections") is Array or frame.sections.size() > 18: return false
	var bounds = frame.get("bounds")
	if not bounds is Dictionary or not point(bounds.get("origin")) or not point(bounds.get("size")) or bounds.size.x != 17 or bounds.size.y != 13 or bounds.size.z != 17: return false
	var origin = bounds.origin
	if origin.x != floor(frame.position.x) - 8 or origin.y != floor(frame.position.y) - 6 or origin.z != floor(frame.position.z) - 8 or origin.y < -64 or origin.y + 12 > 319: return false
	if not frame.get("unknownIndices") is Array or frame.unknownIndices.size() > 3757 or frame.get("unknownCells") != frame.unknownIndices.size(): return false
	var seen_unknown = {}
	for index in frame.unknownIndices:
		if not finite(index) or index != int(index) or index < 0 or index >= 3757 or seen_unknown.has(index): return false
		seen_unknown[index] = true
	var vertices = 0
	for section in frame.sections:
		if not section is Dictionary or not triple(section.get("offset"), 30000032) or not section.get("positions") is Array: return false
		for axis in range(3):
			var low = [origin.x, origin.y, origin.z][axis]
			var extent = [17,13,17][axis]
			var offset = section.offset[axis]
			if offset != int(offset) or posmod(int(offset)-8,16) != 0 or offset < floor(low/16)*16+8 or offset > floor((low+extent-1)/16)*16+8: return false
		var n = section.positions.size() / 3
		if n != int(n) or n < 1 or vertices + n > MAX_VERTICES: return false
		if not array_numbers(section.positions, n * 3, 64) or not array_numbers(section.get("normals"), n * 3, 2) or not array_numbers(section.get("colors"), n * 3, 2) or not array_numbers(section.get("uvs"), n * 2, 16): return false
		for i in range(section.positions.size()):
			var axis = i % 3
			var lower = [origin.x,origin.y,origin.z][axis]
			var extent = [17,13,17][axis]
			var coordinate = section.positions[i] + section.offset[axis]
			if coordinate < lower - 0.5 or coordinate > lower + extent + 0.5: return false
		if not section.get("indices") is Array or section.indices.size() % 3 != 0 or section.indices.size() > n * 6: return false
		for index in section.indices:
			if not finite(index) or index != int(index) or index < 0 or index >= n: return false
		vertices += n
	vertex_count = vertices
	return true

func private_source(path):
	var cursor = path
	while cursor != "/":
		var parent = DirAccess.open(cursor.get_base_dir())
		if parent == null or parent.is_link(cursor.get_file()): return false
		cursor = cursor.get_base_dir()
	return (FileAccess.get_unix_permissions(directory) & 63) == 0 and (FileAccess.get_unix_permissions(path) & 63) == 0

func poll_frame():
	if material == null: return
	var path = directory.path_join("mesh-frame.json")
	if not private_source(path): mark_stale("Private source unavailable"); return
	var file = FileAccess.open(path, FileAccess.READ)
	if file == null or file.get_length() > MAX_BYTES: mark_stale("Source unavailable or too large"); return
	var content = file.get_as_text(); file.close()
	var digest = content.sha256_text()
	if digest == last_digest and is_live: return
	var frame = JSON.parse_string(content)
	if not valid_frame(frame): mark_stale("World stream stopped, expired or invalid"); return
	if frame.sourceGeneration < last_generation or (frame.sourceGeneration == last_generation and frame.sourceSequence < last_sequence): mark_stale("Old world frame rejected"); return
	deadline = stamp(frame.validUntil)
	last_digest = digest; last_generation = frame.sourceGeneration; last_sequence = frame.sourceSequence
	render_frame(frame)

func clear_world():
	for child in world.get_children(): world.remove_child(child); child.queue_free()

func mark_stale(message):
	if test_frames > 0 and message != last_stale_message: print("STALE: " + message)
	last_stale_message = message
	is_live = false; deadline = 0; last_digest = ""; vertex_count = 0
	Engine.max_fps = 2
	if world != null: clear_world()
	if stale_cover != null:
		stale_cover.visible = true
		stale_label.text = "NO CURRENT 3D OBSERVATION\n\n" + message + "\n\nFile-only reconstruction. No game connection or controls."

func render_frame(frame):
	clear_world()
	var p = frame.position
	focus = Vector3(p.x, p.y + 0.8, p.z)
	for section in frame.sections:
		var arrays = []; arrays.resize(Mesh.ARRAY_MAX)
		var vertices = PackedVector3Array(); var normals = PackedVector3Array(); var colors = PackedColorArray(); var uv = PackedVector2Array()
		for i in range(section.positions.size() / 3):
			vertices.append(Vector3(section.positions[i*3], section.positions[i*3+1], section.positions[i*3+2]))
			normals.append(Vector3(section.normals[i*3], section.normals[i*3+1], section.normals[i*3+2]))
			colors.append(Color(section.colors[i*3], section.colors[i*3+1], section.colors[i*3+2], 1))
			uv.append(Vector2(section.uvs[i*2], section.uvs[i*2+1]))
		arrays[Mesh.ARRAY_VERTEX] = vertices; arrays[Mesh.ARRAY_NORMAL] = normals; arrays[Mesh.ARRAY_COLOR] = colors; arrays[Mesh.ARRAY_TEX_UV] = uv; arrays[Mesh.ARRAY_INDEX] = PackedInt32Array(section.indices)
		var mesh = ArrayMesh.new(); mesh.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, arrays)
		var instance = MeshInstance3D.new(); instance.mesh = mesh; instance.material_override = material
		instance.position = Vector3(section.offset[0], section.offset[1], section.offset[2]) - focus; world.add_child(instance)
	var origin = frame.bounds.origin; var base = Vector3(origin.x, origin.y, origin.z) - focus
	add_bounds(base, Vector3(17, 13, 17))
	if frame.unknownIndices.size() > 0:
		var mask = MultiMesh.new(); mask.transform_format = MultiMesh.TRANSFORM_3D; mask.mesh = BoxMesh.new(); mask.instance_count = frame.unknownIndices.size()
		for i in range(frame.unknownIndices.size()):
			var index = int(frame.unknownIndices[i]); var x = index % 17; var z = int(index / 17) % 17; var y = int(index / 289)
			mask.set_instance_transform(i, Transform3D(Basis.IDENTITY, base + Vector3(x+0.5,y+0.5,z+0.5)))
		var cloud = MultiMeshInstance3D.new(); cloud.multimesh = mask; cloud.material_override = flat_material(Color(1,0.1,0.7,0.18)); world.add_child(cloud)
	var marker = MeshInstance3D.new(); var body = CapsuleMesh.new(); body.radius = 0.25; body.height = 1.6; marker.mesh = body; marker.material_override = flat_material(Color(0.25,0.9,1)); world.add_child(marker)
	is_live = true; stale_cover.visible = false
	Engine.max_fps = 15
	if test_frames > 0: print(JSON.stringify({"synthetic":synthetic,"sourceSequence":frame.sourceSequence,"fps":Engine.get_frames_per_second(),"vertices":vertex_count}))
	label.text = ("SYNTHETIC FIXTURE  |  " if synthetic else "") + "BOUNDED 3D RECONSTRUCTION  |  READ ONLY  |  17 x 13 x 17 cells\nMagenta = unknown cells (%d). Amber = cutaway boundary. Cyan = observed player.\nDrag to orbit. Wheel to zoom. Local camera only. %d vertices." % [frame.unknownCells, vertex_count]

func flat_material(color):
	var m = StandardMaterial3D.new(); m.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED; m.albedo_color = color
	if color.a < 1: m.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	return m

func add_bounds(base, size):
	var line = ImmediateMesh.new(); line.surface_begin(Mesh.PRIMITIVE_LINES, flat_material(Color(1,0.75,0.25)))
	for axis in range(3):
		for a in [0,1]:
			for b in [0,1]:
				var first = base; first[(axis+1)%3] += a*size[(axis+1)%3]; first[(axis+2)%3] += b*size[(axis+2)%3]
				var last = first; last[axis] += size[axis]; line.surface_add_vertex(first); line.surface_add_vertex(last)
	line.surface_end(); var instance = MeshInstance3D.new(); instance.mesh = line; world.add_child(instance)

func _process(delta):
	frame_counter += 1
	if verify_pixels:
		if Time.get_ticks_msec() - pixel_started > 60000: print("Native pixel verification timed out"); get_tree().quit(1)
		if saw_live_pixels and is_live and vertex_count != first_pixel_vertices: saw_geometry_change = true
		if not pixel_busy and ((is_live and not saw_live_pixels) or (saw_live_pixels and saw_geometry_change and not is_live)): verify_rendered_pixels()
	if test_frames > 0 and frame_counter >= test_frames:
		print(JSON.stringify({"frames":frame_counter,"live":is_live,"vertices":vertex_count,"fps":Engine.get_frames_per_second(),"memoryBytes":OS.get_static_memory_usage()})); get_tree().quit()
	if is_live and Time.get_unix_time_from_system() >= deadline: mark_stale("World lease expired; old geometry cleared")
	poll_at += delta
	if poll_at >= 0.5: poll_at = 0; poll_frame()
	if camera != null:
		camera.position = Vector3(sin(orbit)*cos(elevation), sin(elevation), cos(orbit)*cos(elevation)) * distance
		camera.look_at(Vector3.ZERO)

func _unhandled_input(event):
	if event is InputEventMouseMotion and event.button_mask & MOUSE_BUTTON_MASK_LEFT:
		orbit -= event.relative.x * 0.006; elevation = clamp(elevation + event.relative.y * 0.006, -0.1, 1.4)
	if event is InputEventMouseButton and event.pressed:
		if event.button_index == MOUSE_BUTTON_WHEEL_UP: distance = max(4, distance - 1)
		if event.button_index == MOUSE_BUTTON_WHEEL_DOWN: distance = min(50, distance + 1)

func verify_rendered_pixels():
	pixel_busy = true
	await RenderingServer.frame_post_draw
	var pixels = get_viewport().get_texture().get_image()
	var green = 0; var brown = 0; var dark = 0; var total = 0
	for y in range(0, pixels.get_height(), 4):
		for x in range(0, pixels.get_width(), 4):
			var c = pixels.get_pixel(x, y); total += 1
			if c.g > c.r * 1.1 and c.g > c.b * 1.3 and c.g > 0.15: green += 1
			if c.r > c.g * 1.15 and c.g > c.b * 1.1 and c.r > 0.2: brown += 1
			if max(c.r, max(c.g, c.b)) < 0.1: dark += 1
	if is_live:
		var passed = green > 300 and brown > 300 and world.get_child_count() > 0
		print(JSON.stringify({"nativePixelCheck":true,"synthetic":synthetic,"stage":"live","passed":passed,"greenPixels":green,"brownPixels":brown,"vertices":vertex_count}))
		if not passed: get_tree().quit(1)
		else: saw_live_pixels = true; first_pixel_vertices = vertex_count
	else:
		var passed = saw_live_pixels and saw_geometry_change and stale_cover.visible and world.get_child_count() == 0 and green < 10 and dark > total * 0.9
		print(JSON.stringify({"nativePixelCheck":true,"synthetic":synthetic,"stage":"stale","passed":passed,"geometryChanged":saw_geometry_change,"greenPixels":green,"darkFraction":float(dark)/total}))
		get_tree().quit(0 if passed else 1)
	pixel_busy = false
